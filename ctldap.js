/**
 * ctldap - ChurchTools LDAP-Wrapper 3.0
 * This tool requires a node.js-Server and a recent version of ChurchTools 3
 * @copyright 2017-2023 Michael Lux
 * @copyright 2019-2020 Matthias Huber
 * @copyright André Schild
 * @licence GNU/GPL v3.0
 */
import fs from "fs";
import ldapjs from "ldapjs";
const { InsufficientAccessRightsError, InvalidCredentialsError, OtherError, parseDN } = ldapjs;
import { CtldapConfig } from "./ctldap-config.js";
import { patchLdapjsFilters } from "./ldapjs-filter-overrides.js";

// Make some ldapjs filters case-insensitive
patchLdapjsFilters();

/**
 * Simple integer range as array, inspired by https://developer.mozilla.org
 * @param start Start integer, inclusive
 * @param end Stop integer, exclusive
 * @return {number[]} Array with number sequence
 */
const range = (start, end) => Array.from({ length: end - start }, (_, i) => start + i);

const config = new CtldapConfig();

function getIsoDate() {
  return new Date().toISOString();
}

export const logTrace = (site, msg)  => {
  if (config.trace) {
    console.log(`${getIsoDate()} [TRACE] ${site.name} - ${msg}`);
  }
}

export const logDebug = (site, msg) => {
  if (config.debug) {
    console.log(`${getIsoDate()} [DEBUG] ${site.name} - ${msg}`);
  }
}

export const logWarn = (site, msg) => {
  console.warn(`${getIsoDate()} [WARN]  ${site.name} - ${msg}`);
}

export const logError = (site, msg, error) => {
  console.error(`${getIsoDate()} [ERROR] ${site.name} - ${msg}`);
  if (error !== undefined) {
    console.error(error.stack);
  }
}

logDebug({ name: 'root logger' }, "Debug mode enabled, expect lots of output!");

let options = {};
if (config.ldapCertFilename && config.ldapKeyFilename) {
  const ldapCert = fs.readFileSync(new URL(`./${config.ldapCertFilename}`, import.meta.url), { encoding: "utf8" }),
      ldapKey = fs.readFileSync(new URL(`./${config.ldapKeyFilename}`, import.meta.url), { encoding: "utf8" });
  options = { certificate: ldapCert, key: ldapKey };
}
const server = ldapjs.createServer(options);

const USERS_KEY = 'users', GROUPS_KEY = 'groups', RAW_DATA_KEY = 'rawData';

/**
 * Retrieves data from cache as a Promise or refreshes the data with the provided (async) factory.
 * @param {object} site - The site for which to query the cache
 * @param {string} key - The cache key
 * @param {function} factory - A function returning a Promise that resolves with the new cache entry or rejects
 */
function getCached(site, key, factory) {
  const cache = site.CACHE;
  const co = cache[key] || { time: -1, entry: null };
  const promise = new Promise((resolve, reject) => {
    const time = new Date().getTime();
    if (time - config.cacheLifetime < co.time) {
      logDebug(site, `Returning cached data for key "${key}".`);
      resolve(co.entry);
    } else {
      if (co.promise) {
        logDebug(site, `Returning pending Promise for cache key "${key}".`);
      } else {
        // Call the factory() function to retrieve the Promise for the fresh entry
        // Either resolve with the new entry (plus cache update), or pass on the rejection
        co.promise = factory().then((result) => {
          logDebug(site, `Store cache entry for cache key "${key}".`)
          co.entry = result;
          co.time = new Date().getTime();
          return result;
        }).finally(() => {
          delete co.promise;
        });
      }
      // Wait until promise resolves
      logDebug(site, `Wait on Promise for cache key "${key}".`)
      co.promise.then(resolve, reject);
    }
  });
  cache[key] = co;
  return promise;
}

/**
 * Fetches all data from a paginated API endpoint.
 * Automatically "heals" the wrong behavior of unpatched pagination when requesting with limit of -1
 * by transparently fetching missing record(s) with another request.
 * @param {object} site The site for which this information is requested.
 * @param {string} apiPath The API endpoint to query for all paginated data.
 * @param {object} [searchParams] Additional search params (query parameters)
 */
async function fetchAllPaginated(site, apiPath, searchParams= {}) {
  // Closure for fetching a single page
  const fetchPage = (page) => {
    return site.api.get(apiPath, {
      searchParams: {
        ...searchParams,
        page
      }
    });
  };
  // Get pagination meta cache
  const pCache = site.CACHE.pagination;
  // Assume the same number of pages as last time, default to 1
  const assumedPages = pCache[site] || 1;
  // Fetch assumed number of pages
  const promises = range(1, assumedPages + 1).map(fetchPage);
  // Await first result
  const firstResult = await Promise.any(promises);
  // Check first result for completeness, and fix up results and pagination cache if necessary
  const nPages = firstResult['meta']['pagination']['lastPage'];
  if (nPages !== assumedPages) {
    logDebug(site, `Assumed ${assumedPages} page(s) of data for /api/${apiPath}, but had to load ${nPages}.`);
    // Update meta cache
    pCache[site] = nPages;
    // Fetch remaining pages, if any
    if (nPages > assumedPages) {
      promises.push(...range(assumedPages + 1, nPages + 1).map(fetchPage));
    }
  } else {
    logDebug(site, `Assumed ${assumedPages} page(s) of data for /api/${apiPath}, which was correct.`);
  }
  // Await all results
  const results = await Promise.all(promises);
  // Collect all data via flatMap() and return it
  return results.flatMap(r => r['data']);
}

/**
 * Fetches all mappings of persons and groups.
 * @param {object} site The site for which this information is requested.
 */
async function fetchMemberships(site) {
  const result = await site.api.get('groups/members', {
    searchParams: {"with_deleted": false}
  });
  logDebug(site, "fetchMemberships done");
  return result['data'];
}

/**
 * Fetches all persons and computes dn values.
 * Persons are filtered by accepted invitations, because uninvited users cannot do logins anyway.
 * @param {object} site The site for which this information is requested.
 */
async function fetchPersons(site) {
  const data = await fetchAllPaginated(site, 'persons', { limit: 500 });
  logDebug(site, "fetchPersons done");
  const personMap = {};
  data.forEach((p) => {
    if (p['invitationStatus'] === "accepted") {
      personMap[p['id']] = p;
      p.dn = site.compatTransform(site.fnUserDn(p['cmsUserId']));
    }
  });
  return personMap;
}

/**
 * Fetches all groups and computes dn values and "special classes" for custom LDAP objectClass attributes.
 * @param {object} site The site for which this information is requested.
 */
async function fetchGroups(site) {
  const data = await fetchAllPaginated(site, 'groups', { limit: 100 });
  logDebug(site, "fetchGroups done");
  const groupMap = {};
  const sgmKeys = Object.keys(site.specialGroupMappings);
  data.forEach((g) => {
    // Strip some irrelevant information
    delete g['settings'];
    delete g['roles'];
    // Pre-compute the "distinguished name" of this group for LDAP
    g.dn = site.compatTransform(site.fnGroupDn(g['name']));
    const info = g['information'];
    g.specialClasses = sgmKeys.filter((k) => info[k])
    groupMap[g['id']] = g;
  });
  return groupMap;
}

/**
 * Fetches all group types from person master data.
 * @param {object} site The site for which this information is requested.
 */
async function fetchGroupTypes(site) {
  const result = await site.api.get('person/masterdata');
  logDebug(site, "fetchGroupTypes done");
  const groupTypes = {};
  // noinspection JSUnresolvedFunction
  result['data']['groupTypes'].forEach((gt) => groupTypes[gt['id']] = gt['name']);
  return groupTypes;
}

/**
 * Collects all required group and user information and computes group-to-users and user-to-groups mappings.
 * @param {object} site The site for which this information is requested.
 */
async function fetchAll(site) {
  return await getCached(site, RAW_DATA_KEY, async () => {
    const [personMap, groupMap, memberships, groupTypes] = await Promise.all([
      fetchPersons(site), fetchGroups(site), fetchMemberships(site), fetchGroupTypes(site)
    ]);
    // Create membership mappings
    const g2p = {}, p2g = {};
    memberships.forEach((m) => {
      const { personId, groupId } = m;
      // Only map persons/groups that have not been filtered
      if ((personId in personMap) && (groupId in groupMap)) {
        // Entry for group-to-persons-mappings
        if (!g2p[groupId]) {
          g2p[groupId] = [personId];
        } else {
          g2p[groupId].push(personId);
        }
        // Entry for person-to-groups-mappings
        if (!p2g[personId]) {
          p2g[personId] = [groupId];
        } else {
          p2g[personId].push(groupId);
        }
      }
    });
    return { groupTypes, g2p, p2g, personMap, groupMap };
  });
}

/**
 * Retrieves the users for the processed request as a Promise.
 * @param {object} req - Request object
 * @param {object} _res - Response object
 * @param {function} next - Next handler function of filter chain
 */
function requestUsers(req, _res, next) {
  const site = req.site;
  req.usersPromise = getCached(site, USERS_KEY, async () => {
    const { p2g, personMap, groupMap } = await fetchAll(site);
    let newCache = Object.entries(personMap).map(([id, p]) => {
      const cn = p['cmsUserId'];
      const email = site.compatTransformEmail(p['email']);
      return {
        dn: p.dn,
        attributes: {
          cn,
          displayName: `${p['firstName']} ${p['lastName']}`,
          id,
          uid: cn,
          nsUniqueId: `u${id}`,
          givenName: p['firstName'],
          street: p['street'],
          telephoneMobile: p['mobile'],
          telephoneHome: p['phonePrivate'],
          postalCode: p['zip'],
          l: p['city'],
          sn: p['lastName'],
          email,
          mail: email,
          objectClass: [
            'person',
            'CTPerson',
            // Map special CT field names of associated groups to the LDAP objectClass names defined in configuration.
            ...(p2g[id] || [])
                .flatMap((gid) => groupMap[gid].specialClasses)
                .map((key) => site.specialGroupMappings[key]['personClass'])
          ],
          memberOf: (p2g[id] || []).map((gid) => groupMap[gid].dn)
        }
      };
    });
    newCache = site.uniqueEmails(newCache);
    // Virtual admin user
    if (site.ldapPassword !== undefined) {
      const cn = site.ldapUser;
      newCache.push({
        dn: site.compatTransform(site.fnUserDn(cn)),
        attributes: {
          cn,
          displayname: "LDAP Administrator",
          id: 0,
          uid: cn,
          nsUniqueId: "u0",
          givenName: "LDAP Administrator",
          objectClass: ['person'],
        }
      });
    }
    const size = newCache.length;
    logDebug(site, "Updated users: " + size);
    return newCache;
  });
  return next();
}

/**
 * Retrieves the groups for the processed request as a Promise.
 * @param {object} req - Request object
 * @param {object} _res - Response object
 * @param {function} next - Next handler function of filter chain
 */
function requestGroups(req, _res, next) {
  const site = req.site;
  req.groupsPromise = getCached(site, GROUPS_KEY, async () => {
    const { groupTypes, g2p, personMap, groupMap } = await fetchAll(site);
    const newCache = Object.entries(groupMap).map(([id, g]) => {
      const cn = g['name'];
      const info = g['information'];
      const groupType = groupTypes[info['groupTypeId']];
      const objectClasses = ["group", "CTGroup" + groupType.charAt(0).toUpperCase() + groupType.slice(1),
        // Map observed special CT field names to the LDAP objectClass names defined in configuration.
        ...g.specialClasses.map((key) => site.specialGroupMappings[key]['groupClass'])];
      return {
        dn: g.dn,
        attributes: {
          cn,
          displayname: g['name'],
          id,
          nsUniqueId: `g${id}`,
          objectClass: objectClasses,
          uniqueMember: (g2p[id] || []).map((pid) => personMap[pid].dn)
        }
      };
    });
    const size = newCache.length;
    logDebug(site, "Updated groups: " + size);
    return newCache;
  });
  return next();
}

/**
 * Validates root user authentication by comparing the bind DN with the configured admin DN.
 * @param {object} req - Request object
 * @param {object} _res - Response object
 * @param {function} next - Next handler function of filter chain
 */
function authorize(req, _res, next) {
  if (!req.connection.ldap.bindDN.equals(req.site.adminDn)) {
    logWarn(req.site, "Rejected search without proper binding!");
    return next(new InsufficientAccessRightsError());
  }
  return next();
}

/**
 * Performs debug logging if debug mode is enabled.
 * @param {object} req - Request object
 * @param {object} _res - Response object
 * @param {function} next - Next handler function of filter chain
 */
function searchLogging(req, _res, next) {
  logDebug(req.site, "SEARCH base object: " + req.dn.toString() + " scope: " + req.scopeName);
  logDebug(req.site, "Filter: " + req.filter.toString());
  return next();
}

/**
 * Evaluates req.usersPromise and sends matching elements to the client.
 * @param {object} req - Request object
 * @param {object} res - Response object
 * @param {function} next - Next handler function of filter chain
 */
function sendUsers(req, res, next) {
  req.usersPromise.then((users) => {
    users.forEach((u) => {
      if ((req.checkAll || req.dn.equals(u.dn)) && req.filter.matches(u.attributes, false)) {
        logTrace(req.site, "MatchUser: " + u.dn.toString());
        res.send(u);
      }
    });
    return next();
  }, (error) => {
    logError(req.site, "Error whilst retrieving users: ", error);
    return next();
  });
}

/**
 * Evaluates req.groupsPromise and sends matching elements to the client.
 * @param {object} req - Request object
 * @param {object} res - Response object
 * @param {function} next - Next handler function of filter chain
 */
function sendGroups(req, res, next) {
  req.groupsPromise.then((groups) => {
    groups.forEach((g) => {
      if ((req.checkAll || req.dn.equals(g.dn)) && req.filter.matches(g.attributes, false)) {
        logTrace(req.site, "MatchGroup: " + g.dn);
        res.send(g);
      }
    });
    return next();
  }, (error) => {
    logError(req.site, "Error whilst retrieving groups: ", error);
    return next();
  });
}

/**
 * Calls the res.end() function to finalize successful chain processing.
 * @param {object} _req - Request object
 * @param {object} res - Response object
 * @param {function} next - Next handler function of filter chain
 */
function endSuccess(_req, res, next) {
  res.end();
  return next();
}

/**
 * Checks the given credentials against the credentials in the config file or against the ChurchTools API.
 * @param {object} req - Request object
 * @param {object} _res - Response object
 * @param {function} next - Next handler function of filter chain
 */
async function authenticate(req, _res, next) {
  const site = req.site;
  if (req.dn === site.adminDn) {
    logDebug(site, "Admin bind DN: " + req.dn);
    // If ldapPassword is undefined, try a default ChurchTools authentication with this user
    if (site.ldapPassword !== undefined) {
      try {
        await site.authenticateAdmin(req.credentials);
        logDebug(site, "Admin bind successful");
        return next();
      } catch (error) {
        logError(site, `Invalid password for admin bind or auth error: `, error);
        return next(new InvalidCredentialsError());
      }
    } else {
      logDebug("ldapPassword is undefined, trying ChurchTools authentication...")
    }
  } else {
    logDebug(site, "Bind user DN: %s", req.dn);
  }
  const username = parseDN(req.dn).rdnAt(0).getValue("cn");
  try {
    await site.api.post('login', {
      json: {
        "username": username,
        "password": req.credentials
      }
    });
    logDebug(site, "Authentication successful for " + req.dn);
    return next();
  } catch (error) {
    if (error.response?.statusCode === 400) {
      logWarn(site, `Authentication error (CT API HTTP 400) occurred for ${username} (probably wrong password): ${error}`);
      return next(new InvalidCredentialsError());
    } else {
      logError(site, `Authentication error for ${username}: ${error}`);
      return next(new OtherError());
    }
  }
}

config.sites.forEach((site) => {
  // Login bind for user
  server.bind(`ou=users,o=${site.name}`, (req, _res, next) => {
    req.site = site;
    next();
  }, authenticate, endSuccess);

  // Search implementation for user search
  server.search(`ou=users,o=${site.name}`, (req, _res, next) => {
    req.site = site;
    next();
  }, searchLogging, authorize, (req, _res, next) => {
    logDebug(site, "Search for users");
    req.checkAll = req.scopeName !== "base" && req.dn.length === 2;
    return next();
  }, requestUsers, sendUsers, endSuccess);

  // Search implementation for group search
  server.search(`ou=groups,o=${site.name}`, (req, _res, next) => {
    req.site = site;
    next();
  }, searchLogging, authorize, (req, _res, next) => {
    logDebug(site, "Search for groups");
    req.checkAll = req.scopeName !== "base" && req.dn.length === 2;
    return next();
  }, requestGroups, sendGroups, endSuccess);

  // Search implementation for user and group search
  server.search(`o=${site.name}`, (req, _res, next) => {
    req.site = site;
    next();
  }, searchLogging, authorize, (req, _res, next) => {
    logDebug(site, "Search for users and groups combined");
    req.checkAll = req.scopeName === "subtree";
    return next();
  }, requestUsers, requestGroups, sendUsers, sendGroups, endSuccess);
});

// Search implementation for basic search for Directory Information Tree and the LDAP Root DSE
server.search('', (req, res) => {
  // noinspection JSUnresolvedVariable
  logDebug({ name: req.dn.o }, "Empty request, return directory information");
  // noinspection JSUnresolvedVariable
  const obj = {
    "attributes": {
      "objectClass": ["top", "OpenLDAProotDSE"],
      "subschemaSubentry": ["cn=subschema"],
      "namingContexts": "o=" + req.dn.o,
    },
    "dn": "",
  };

  if (req.filter.matches(obj.attributes, false)) {
    res.send(obj);
  }

  res.end();
}, endSuccess);

// Start LDAP server
server.listen(parseInt(config.ldapPort), config.ldapIp, () => {
  logDebug({ name: 'root logger' }, `ChurchTools-LDAP-Wrapper listening @ ${server.url}`);
});

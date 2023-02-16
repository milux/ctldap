// ctldap - ChurchTools LDAP-Wrapper 3.0
// This tool requires a node.js-Server and a recent version of ChurchTools 3
// (c) 2017-2023 Michael Lux
// (c) 2019-2020 Matthias Huber
// (c) 2019 André Schild
// License: GNU/GPL v3.0

import got from 'got';
import helpers from "ldap-filter";
import bcrypt from "bcrypt";
import argon2 from "argon2";
import ldapEsc from "ldap-escape";
import fs from "fs";
import ldap from "ldapjs";
import { readYamlEnvSync } from 'yaml-env-defaults';

const parseDN = ldap.parseDN;
const yaml = readYamlEnvSync('./ctldap.yml');
const config = yaml.config;
const sites = yaml.sites || {};

function getIsoDate() {
  return new Date().toISOString();
}

function logDebug(site, msg) {
  if (config.debug) {
    console.log(`${getIsoDate()} [DEBUG] ${site.siteName} - ${msg}`);
  }
}

function logWarn(site, msg) {
  console.warn(`${getIsoDate()} [WARN]  ${site.siteName} - ${msg}`);
}

function logError(site, msg, error) {
  console.error(`${getIsoDate()} [ERROR] ${site.siteName} - ${msg}`);
  if (error !== undefined) {
    console.error(error.stack);
  }
}

logDebug({ siteName: 'root logger' }, "Debug mode enabled, expect lots of output!");

if (typeof config.cacheLifetime !== 'number' && isNaN(config.cacheLifetime)) {
  config.cacheLifetime = 300000;  // 5 minutes
}

// If no sites are configured, create one from the global config properties
if (config.ldapBaseDn) {
  sites[config.ldapBaseDn] = {
    siteName: config.ldapBaseDn,
    ldapPassword: config.ldapPassword,
    ctUri: config.ctUri,
    apiToken: config.apiToken,
    specialGroupMappings: config.specialGroupMappings
  }
}

Object.keys(sites).map((siteName) => {
  const site = sites[siteName];

  site.siteName = siteName;
  site.fnUserDn = ldapEsc.dn("cn=${cn},ou=users,o=" + siteName);
  site.fnGroupDn = ldapEsc.dn("cn=${cn},ou=groups,o=" + siteName);
  site.api = got.extend({
    headers: { "Authorization": `Login ${site.apiToken}` },
    prefixUrl: `${site.ctUri.replace(/\/$/g, '')}/api`,
    responseType: 'json',
    resolveBodyOnly: true,
    http2: true
  });
  site.adminDn = site.fnUserDn({ cn: config.ldapUser });
  site.CACHE = {};
  site.loginErrorCount = 0;
  site.loginBlockedDate = null;

  const identityFn = (p) => p;
  const stringLowerFn = (s) => typeof s === "string" ? s.toLowerCase() : s;

  if (site.dnLowerCase || ((site.dnLowerCase === undefined) && config.dnLowerCase)) {
    site.compatTransform = stringLowerFn;
  } else {
    site.compatTransform = identityFn;
  }

  if (site.emailLowerCase || ((site.emailLowerCase === undefined) && config.emailLowerCase)) {
    site.compatTransformEmail = stringLowerFn;
  } else {
    site.compatTransformEmail = identityFn;
  }

  if (site.emailsUnique || ((site.emailsUnique === undefined) && config.emailsUnique)) {
    site.uniqueEmails = (users) => {
      const mails = {};
      return users.filter((user) => {
        if (!user.attributes.email) {
          return false;
        }
        const result = !(user.attributes.email in mails);
        mails[user.attributes.email] = true;
        return result;
      });
    };
  } else {
    site.uniqueEmails = identityFn;
  }

  site.authenticateAdmin = async (password) => {
    if (site.loginBlockedDate) {
      const now = new Date();
      const checkDate = new Date(site.loginBlockedDate.getTime() + 1000 * 3600 * 24); // one day
      if (now < checkDate) {
        throw Error("Login blocked!");
      } else {
        site.loginBlockedDate = null;
        site.loginErrorCount = 0;
      }
    }
    try {
      await site.checkPassword(password);
    } catch (error) {
      site.loginErrorCount += 1;
      if (site.loginErrorCount > 5) {
        site.loginBlockedDate = new Date();
      }
      throw error;
    }
  };

  // If LDAP admin password has been provided, set the right verification algorithm based on hash format.
  if (site.ldapPassword) {
    if (/^\$2[yab]\$/.test(site.ldapPassword)) {
      // Assume bcrypt hash
      site.checkPassword = async (password) => {
        const hash = site.ldapPassword.replace(/^\$2y\$/, '$2a$');
        if (!await bcrypt.compare(password, hash)) {
          throw Error("Wrong password, bcrypt hash didn't match!");
        }
      };
    } else if (/^\$argon2[id]{1,2}\$/.test(site.ldapPassword)) {
      // Assume argon2 hash
      site.checkPassword = async (password) => {
        if (!await argon2.verify(site.ldapPassword, password)) {
          throw Error("Wrong password, argon2 hash didn't match!");
        }
      }
    } else {
      // Assume plaintext password
      site.checkPassword = async (password) => {
        if (password !== site.ldapPassword) {
          throw Error("Wrong password, plaintext didn't match!")
        }
      };
    }
  }
});

let options = {};
if (config.ldapCertFilename && config.ldapKeyFilename) {
  const ldapCert = fs.readFileSync(new URL(`./${config.ldapCertFilename}`, import.meta.url), { encoding: "utf8" }),
      ldapKey = fs.readFileSync(new URL(`./${config.ldapKeyFilename}`, import.meta.url), { encoding: "utf8" });
  options = { certificate: ldapCert, key: ldapKey };
}
const server = ldap.createServer();

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

async function fetchAllPaginatedHack(site, apiPath, searchParams) {
  // Get all records except the last one
  const result = await site.api.get(apiPath, {
    searchParams: {
      ...searchParams,
      limit: -1
    }
  });
  const data = result['data'];
  const total = result['meta']['pagination']['total'];
  if (data.length < total) {
    // Fetch last record and append it to the result
    const limit = total - data.length;
    const last = await site.api.get(apiPath, {
      searchParams: {
        ...searchParams,
        limit,
        page: Math.ceil(total / limit)
      }
    });
    data.push(last['data'][0]);
  }
  return data;
}

async function fetchMemberships(site) {
  const result = await site.api.get('groups/members', {
    searchParams: {"with_deleted": false}
  });
  logDebug(site, "fetchMemberships done");
  return result['data'];
}

async function fetchPersons(site) {
  const data = await fetchAllPaginatedHack(site, 'persons');
  logDebug(site, "fetchPersons done");
  const personMap = {};
  data.forEach((p) => {
    if (p['invitationStatus'] === "accepted") {
      personMap[p['id']] = p;
      p.dn = site.compatTransform(site.fnUserDn({cn: p['cmsUserId']}));
    }
  });
  return personMap;
}

async function fetchGroups(site) {
  const data = await fetchAllPaginatedHack(site, 'groups');
  logDebug(site, "fetchGroups done");
  const groupMap = {};
  const sgmKeys = Object.keys(site.specialGroupMappings);
  data.forEach((g) => {
    const info = g['information'];
    g.specialClasses = sgmKeys.filter((k) => info[k])
    // Strip some irrelevant information
    delete g['settings'];
    delete g['roles'];
    groupMap[g['id']] = g;
    g.dn = site.compatTransform(site.fnGroupDn({cn: g['name']}));
  });
  return groupMap;
}

async function fetchGroupTypes(site) {
  const result = await site.api.get('person/masterdata');
  logDebug(site, "fetchGroupTypes done");
  const groupTypes = {};
  result['data']['groupTypes'].forEach((gt) => groupTypes[gt['id']] = gt['name']);
  return groupTypes;
}

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
          displayname: `${p['firstName']} ${p['lastName']}`,
          id,
          uid: cn,
          nsuniqueid: `u${id}`,
          givenname: p['firstName'],
          street: p['street'],
          telephoneMobile: p['mobile'],
          telephoneHome: p['phonePrivate'],
          postalCode: p['zip'],
          l: p['city'],
          sn: p['lastName'],
          email,
          mail: email,
          objectclass: [
            'person',
            'CTPerson',
            ...(p2g[id] || [])
                .flatMap((gid) => groupMap[gid].specialClasses)
                .map((key) => site.specialGroupMappings[key]['personClass'])
          ],
          memberof: (p2g[id] || []).map((gid) => groupMap[gid].dn)
        }
      };
    });
    newCache = site.uniqueEmails(newCache);
    // Virtual admin user
    if (site.ldapPassword !== undefined) {
      const cn = config.ldapUser;
      newCache.push({
        dn: site.compatTransform(site.fnUserDn({ cn: cn })),
        attributes: {
          cn,
          displayname: "LDAP Administrator",
          id: 0,
          uid: cn,
          nsuniqueid: "u0",
          givenname: "LDAP Administrator",
          objectclass: ['person'],
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
        ...g.specialClasses.map((key) => site.specialGroupMappings[key]['groupClass'])];
      return {
        dn: g.dn,
        attributes: {
          cn,
          displayname: g['name'],
          id,
          nsuniqueid: `g${id}`,
          objectclass: objectClasses,
          uniquemember: (g2p[id] || []).map((pid) => personMap[pid].dn)
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
    return next(new Error("Insufficient access rights, must bind to LDAP admin user first!"));
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
  logDebug(req.site, "SEARCH base object: " + req.dn.toString() + " scope: " + req.scope);
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
  const strDn = req.dn.toString();
  req.usersPromise.then((users) => {
    users.forEach((u) => {
      if ((req.checkAll || parseDN(strDn).equals(parseDN(u.dn))) && (req.filter.matches(u.attributes))) {
        logDebug(req.site, "MatchUser: " + u.dn);
        res.send(u);
      }
    });
    return next();
  }, (error) => {
    logError(req.site, "Error while retrieving users: ", error);
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
  const strDn = req.dn.toString();
  req.groupsPromise.then((groups) => {
    groups.forEach((g) => {
      if ((req.checkAll || parseDN(strDn).equals(parseDN(g.dn))) && (req.filter.matches(g.attributes))) {
        logDebug(req.site, "MatchGroup: " + g.dn);
        res.send(g);
      }
    });
    return next();
  }, (error) => {
    logError(req.site, "Error while retrieving groups: ", error);
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
  if (req.dn.equals(site.adminDn)) {
    logDebug(site, "Admin bind DN: " + req.dn.toString());
    // If ldapPassword is undefined, try a default ChurchTools authentication with this user
    if (site.ldapPassword !== undefined) {
      try {
        await site.authenticateAdmin(req.credentials);
        logDebug(site, "Admin bind successful");
        return next();
      } catch (error) {
        logError(site, `Invalid password for admin bind or auth error: ${error.message}`);
        return next(error);
      }
    } else {
      logDebug("ldapPassword is undefined, trying ChurchTools authentication...")
    }
  } else {
    logDebug(site, "Bind user DN: %s", req.dn);
  }
  try {
    await site.api.post('login', {
      json: {
        "username": req.dn.rdns[0].attrs.cn.value,
        "password": req.credentials
      }
    });
    logDebug(site, "Authentication successful for " + req.dn.toString());
    return next();
  } catch (error) {
    logError(site, "Authentication error: ", error);
    return next(new Error("Invalid LDAP password"));
  }
}

Object.keys(sites).map((siteName) => {
  // Login bind for user
  server.bind("ou=users,o=" + siteName, (req, _res, next) => {
    req.site = sites[siteName];
    next();
  }, authenticate, endSuccess);

  // Search implementation for user search
  server.search("ou=users,o=" + siteName, (req, _res, next) => {
    req.site = sites[siteName];
    next();
  }, searchLogging, authorize, (req, _res, next) => {
    logDebug({ siteName: siteName }, "Search for users");
    req.checkAll = req.scope !== "base" && req.dn.rdns.length === 2;
    return next();
  }, requestUsers, sendUsers, endSuccess);

  // Search implementation for group search
  server.search("ou=groups,o=" + siteName, (req, _res, next) => {
    req.site = sites[siteName];
    next();
  }, searchLogging, authorize, (req, _res, next) => {
    logDebug({ siteName: siteName }, "Search for groups");
    req.checkAll = req.scope !== "base" && req.dn.rdns.length === 2;
    return next();
  }, requestGroups, sendGroups, endSuccess);

  // Search implementation for user and group search
  server.search("o=" + siteName, (req, _res, next) => {
    req.site = sites[siteName];
    next();
  }, searchLogging, authorize, (req, _res, next) => {
    logDebug({ siteName: siteName }, "Search for users and groups combined");
    req.checkAll = req.scope === "sub";
    return next();
  }, requestUsers, requestGroups, sendUsers, sendGroups, endSuccess);
});

// Search implementation for basic search for Directory Information Tree and the LDAP Root DSE
server.search('', (req, res) => {
  // noinspection JSUnresolvedVariable
  logDebug({ siteName: req.dn.o }, "Empty request, return directory information");
  // noinspection JSUnresolvedVariable
  const obj = {
    "attributes": {
      "objectClass": ["top", "OpenLDAProotDSE"],
      "subschemaSubentry": ["cn=subschema"],
      "namingContexts": "o=" + req.dn.o,
    },
    "dn": "",
  };

  if (req.filter.matches(obj.attributes)) {
    res.send(obj);
  }

  res.end();
}, endSuccess);


function escapeRegExp(str) {
  /* JSSTYLED */
  return str.replace(/[\-\[\]\/{}()*+?.\\^$|]/g, '\\$&');
}

/** 
 * Case-insensitive search on substring filters
 * Credits to @alansouzati, see https://github.com/ldapjs/node-ldapjs/issues/156
 */
ldap.filters.SubstringFilter.prototype.matches = (target, strictAttrCase) => {
  const tv = helpers.getAttrValue(target, this.attribute, strictAttrCase);
  if (tv !== undefined && tv !== null) {
    let re = '';

    if (this.initial) {
      re += '^' + escapeRegExp(this.initial) + '.*';
    }
    this.any.forEach((s) => re += escapeRegExp(s) + '.*');
    if (this.final) {
      re += escapeRegExp(this.final) + '$';
    }

    const matcher = new RegExp(re, 'i');
    return helpers.testValues((v) => matcher.test(v), tv, false);
  }

  return false;
};


// Start LDAP server
server.listen(parseInt(config.ldapPort), config.ldapIp, () => {
  logDebug({ siteName: 'root logger' }, `ChurchTools-LDAP-Wrapper listening @ ${server.url}`);
});

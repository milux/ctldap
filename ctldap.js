// ChurchTools LDAP-Wrapper 2.1
// This tool requires a node.js-Server and ChurchTools >= 3.25.0
// (c) 2017 Michael Lux
// (c) 2019 André Schild
// License: GNU/GPL v3.0

var ldap = require('ldapjs');
var fs = require('fs');
var ini = require('ini');
var rp = require('request-promise');
var ldapEsc = require('ldap-escape');
var parseDN = require('ldapjs').parseDN;
var extend = require('extend');
var Promise = require("bluebird");
var path = require('path');
var bcrypt = require('bcrypt');

var helpers = require('ldap-filter/lib/helpers');

var config = ini.parse(fs.readFileSync(path.resolve(__dirname, 'ctldap.config'), 'utf-8'));

function logDebug(site, msg) {
  if (config.debug) {
    console.log("[DEBUG] " + site.sitename + " - " + msg);
  }
}

function logWarn(site, msg) {
  console.log("[WARN] " + site.sitename + " - " + msg);
}

function logError(site, msg, error) {
  console.log("[ERROR] " + site.sitename + " - " + msg);
  console.log(error.stack);
}

if (config.debug) {
  console.log("Debug mode enabled, expect lots of output!");
}

// If no sites are configured, create one from the global config properties
if (config.ldap_base_dn) {
  if (!config.sites) {
    config.sites = {};
  }
  config.sites[config.ldap_base_dn] = {
    sitename: config.ldap_base_dn,
    ldap_password: config.ldap_password,
    ct_uri: config.ct_uri,
    api_user: config.api_user,
    api_password: config.api_password
  }
}

Object.keys(config.sites).map(function (sitename) {
  var site = config.sites[sitename];

  site.sitename = sitename;
  site.fnUserDn = ldapEsc.dn("cn=${cn},ou=users,o=" + sitename);
  site.fnGroupDn = ldapEsc.dn("cn=${cn},ou=groups,o=" + sitename);
  site.cookieJar = rp.jar();
  site.loginPromise = null;
  site.adminDn = site.fnUserDn({ cn: config.ldap_user });
  site.CACHE = {};
  site.loginErrorCount = 0;
  site.loginBlockedDate = null;

  if (site.dn_lower_case || ((site.dn_lower_case === undefined) && config.dn_lower_case)) {
    site.compatTransform = function (s) {
      return typeof s === "string" ? s.toLowerCase() : s;
    };
  } else {
    site.compatTransform = function (s) {
      return s;
    };
  }
  if (site.email_lower_case || ((site.email_lower_case === undefined) && config.email_lower_case)) {
    site.compatTransformEmail = function (s) {
      return typeof s === "string" ? s.toLowerCase() : s;
    };
  } else {
    site.compatTransformEmail = function (s) {
      return s;
    };
  }
  if (site.emails_unique || ((site.emails_unique === undefined) && config.emails_unique)) {
    site.uniqueEmails = function (users) {
      var mails = {};
      return users.filter(function (user) {
        if (!user.attributes.email) {
          return false;
        }
        var result = !(user.attributes.email in mails);
        mails[user.attributes.email] = true;
        return result;
      });
    };
  } else {
    site.uniqueEmails = function (users) {
      return users;
    };
  }
  if (site.ldap_password_bcrypt || ((site.ldap_password_bcrypt === undefined) && config.ldap_password_bcrypt)) {
    site.checkPassword = function (password, callback) {
      if (site.loginBlockedDate) {
        var now = new Date();
        var checkDate = new Date(site.loginBlockedDate.getTime() + 1000 * 3600 * 24); // one day
        if (now < checkDate) {
          callback(false);
          return;
        } else {
          site.loginBlockedDate = null;
          site.loginErrorCount = 0;
        }
      }
      var hash = site.ldap_password.replace(/^\$2y(.+)$/i, '$2a$1');
      bcrypt.compare(password, hash, function (_err, valid) {
        if (!valid) {
          site.loginErrorCount += 1;
          if (site.loginErrorCount > 5) {
            site.loginBlockedDate = new Date();
          }
        }
        callback(valid);
      });
    }
  } else {
    site.checkPassword = function (password, callback) {
      if (site.loginBlockedDate) {
        var now = new Date();
        var checkDate = new Date(site.loginBlockedDate.getTime() + 1000 * 3600 * 24); // one day
        if (now < checkDate) {
          callback(false);
          return;
        } else {
          site.loginBlockedDate = null;
          site.loginErrorCount = 0;
        }
      }
      var valid = (password === site.ldap_password);
      if (!valid) {
        site.loginErrorCount += 1;
        if (site.loginErrorCount > 5) {
          site.loginBlockedDate = new Date();
        }
      }
      callback(valid);
    }
  }
  if (site.ct_uri.slice(-1) !== "/") {
    site.ct_uri += "/";
  }
});

if (config.ldap_cert_filename && config.ldap_key_filename) {
  var ldapCert = fs.readFileSync(config.ldap_cert_filename, { encoding: "utf8" }),
    ldapKey = fs.readFileSync(config.ldap_key_filename, { encoding: "utf8" });
  var server = ldap.createServer({ certificate: ldapCert, key: ldapKey });
} else {
  var server = ldap.createServer();
}

if (typeof config.cache_lifetime !== 'number') {
  config.cache_lifetime = 10000;  // 10 seconds
}

function getCsrfToken(site) {
  return rp({
    "method": "GET",
    "jar": site.cookieJar,
    "uri": site.ct_uri + "/api/csrftoken",
    "json": true
  }).then(function (result) {
    if (!result.data) {
      throw new Error(JSON.stringify(result));
    }
    site.csrftoken = result.data;
    logDebug(site, "Got CSRF-Token.");
    return true;
  }).catch(function (error) {
    logDebug(site, "Could not get CSRF-Token: " + JSON.stringify(error));
    return true; // continue anyway, maybe this is an older CT selfhosting version
  });
}

/**
 * Returns a promise for the login on the ChurchTools API.
 * If a pending login promise already exists, it is returned right away.
 */
function apiLogin(site) {
  if (site.loginPromise === null) {
    logDebug(site, "Performing CT API login...");
    site.csrftoken = 'foobar';
    site.loginPromise = rp({
      "method": "POST",
      "jar": site.cookieJar,
      "uri": site.ct_uri + "?q=login/ajax",
      "form": {
        "func": "login",
        "email": site.api_user,
        "password": site.api_password
      },
      "json": true
    }).then(function (result) {
      if (result.status !== "success") {
        logDebug(site, "CT API login failed: " + JSON.stringify(result));
        // clear login promise
        site.loginPromise = null;
        throw new Error(JSON.stringify(result));
      }
      logDebug(site, "CT API login successful, fetching CSRF-Token...");
      return getCsrfToken(site);
    }).then(function () {
      logDebug(site, "CT API login completed");
      // clear login promise
      site.loginPromise = null;
      // end gracefully
      return null;
    });
  } else if (config.debug) {
    logDebug(site, "Return pending login promise");
  }
  return site.loginPromise;
}

/**
 * Retrieves data from the PHP API via a POST call.
 * @param {object} site - The current site
 * @param {function} func - The function to call in the API class
 * @param {object} [data] - The optional form data to pass along with the POST request
 * @param {boolean} [triedLogin] - Is true if this is the second attempt after API login
 */
function apiPost(site, func, data, triedLogin, triedCSRFUpdate) {
  logDebug(site, "Performing request to API function " + func);
  return rp({
    "method": "POST",
    "jar": site.cookieJar,
    "headers": { 'CSRF-Token': site.csrftoken },
    "uri": site.ct_uri + "?q=churchdb/ajax",
    "form": extend({ "func": func }, data || {}),
    "json": true
  }).then(function (result) {
    if (result.status !== "success") {
      // If this was the first attempt, login and try again
      if (!triedLogin) {
        logDebug(site, "CT session invalid, login and retry...");
        return apiLogin(site).then(function () {
          // Retry operation after login
          logDebug(site, "Retry request to API function " + func + " after login");
          // Set "triedLogin" parameter to prevent looping
          return apiPost(site, func, data, true, triedCSRFUpdate);
        });
      } else {
        logError(site, "CT API request still not working after login:");
        throw new Error(JSON.stringify(result));
      }
    }
    return result.data;
  }, function (error) {
    if ((error.error.errors[0].message === "CSRF-Token is invalid") && !triedCSRFUpdate) {
      logDebug(site, "CSRF token is invalid, get new one and retry...");
      return getCsrfToken(site).then(function () {
        // Retry operation
        logDebug(site, "Retry request to API function " + func + " with fresh CSRF token");
        // Set "triedCSRFUpdate" parameter to prevent looping
        return apiPost(site, func, data, triedLogin, true);
      });
    }
    throw error;
  });
}

var USERS_KEY = "users", GROUPS_KEY = "groups";

/**
 * Retrieves data from cache as a Promise or refreshes the data with the provided Promise factory.
 * @param {string} key - The cache key
 * @param {number} maxAge - The maximum age of the cache entry, if older the data will be refreshed
 * @param {function} factory - A function returning a Promise that resolves with the new cache entry or rejects
 */
function getCached(site, key, maxAge, factory) {
  return new Promise(function (resolve, reject) {
    var time = new Date().getTime();
    var co = site.CACHE[key] || { time: -1, entry: null };
    if (time - maxAge < co.time) {
      logDebug(site, "using cached data");
      resolve(co.entry);
    } else {
      // Call the factory() function to retrieve the Promise for the fresh entry
      // Either resolve with the new entry (plus cache update), or pass on the rejection
      factory().then(function (result) {
        co.entry = result;
        co.time = new Date().getTime();
        site.CACHE[key] = co;
        resolve(result);
      }, reject);
    }
  });
}


/**
 * Retrieves the users for the processed request as a Promise.
 * @param {object} req - Request object
 * @param {object} res - Response object
 * @param {function} next - Next handler function of filter chain
 */
function requestUsers(req, _res, next) {
  var site = req.site;
  req.usersPromise = getCached(site, USERS_KEY, config.cache_lifetime, function () {
    return apiPost(site, "getUsersData").then(function (results) {
      var newCache = results.users.map(function (v) {
        var cn = v.cmsuserid;
        return {
          dn: site.compatTransform(site.fnUserDn({ cn: cn })),
          attributes: {
            cn: cn,
            displayname: v.vorname + " " + v.name,
            id: String(v.id),
            uid: cn,
            nsuniqueid: "u" + v.id,
            givenname: v.vorname,
            street: v.strasse,
            telephoneMobile: v.telefonhandy,
            telephoneHome: v.telefonprivat,
            postalCode: v.plz,
            l: v.ort,
            sn: v.name,
            email: site.compatTransformEmail(v.email),
            mail: site.compatTransformEmail(v.email),
            objectclass: ['CTPerson'],
            memberof: (results.userGroups[v.id] || []).map(function (cn) {
              return site.compatTransform(site.fnGroupDn({ cn: cn }));
            })
          }
        };
      });
      newCache = site.uniqueEmails(newCache);
      // Virtual admin user
      if (site.ldap_password !== undefined) {
        var cn = config.ldap_user;
        newCache.push({
          dn: site.compatTransform(site.fnUserDn({ cn: cn })),
          attributes: {
            cn: cn,
            displayname: "LDAP Administrator",
            id: 0,
            uid: cn,
            nsuniqueid: "u0",
            givenname: "LDAP Administrator",
            objectclass: ['CTPerson'],
          }
        });
      }
      var size = newCache.length;
      logDebug(site, "Updated users: " + size);
      return newCache;
    });
  });
  return next();
}

/**
 * Retrieves the groups for the processed request as a Promise.
 * @param {object} req - Request object
 * @param {object} res - Response object
 * @param {function} next - Next handler function of filter chain
 */
function requestGroups(req, _res, next) {
  var site = req.site;
  req.groupsPromise = getCached(site, GROUPS_KEY, config.cache_lifetime, function () {
    return apiPost(site, "getGroupsData").then(function (results) {
      var newCache = results.groups.map(function (v) {
        var cn = v.bezeichnung;
        var groupType = v.gruppentyp;
        return {
          dn: site.compatTransform(site.fnGroupDn({ cn: cn })),
          attributes: {
            cn: cn,
            displayname: v.bezeichnung,
            id: v.id,
            nsuniqueid: "g" + v.id,
            objectclass: ["group", "CTGroup" + groupType.charAt(0).toUpperCase() + groupType.slice(1)],
            uniquemember: (results.groupMembers[v.id] || []).map(function (cn) {
              return site.compatTransform(site.fnUserDn({ cn: cn }));
            })
          }
        };
      });
      var size = newCache.length;
      logDebug(site, "Updated groups: " + size);
      return newCache;
    });
  });
  return next();
}

/**
 * Validates root user authentication by comparing the bind DN with the configured admin DN.
 * @param {object} req - Request object
 * @param {object} res - Response object
 * @param {function} next - Next handler function of filter chain
 */
function authorize(req, _res, next) {
  if (!req.connection.ldap.bindDN.equals(req.site.adminDn)) {
    logWarn(req.site, "Rejected search without proper binding!");
    return next(new ldap.InsufficientAccessRightsError());
  }
  return next();
}

/**
 * Performs debug logging if debug mode is enabled.
 * @param {object} req - Request object
 * @param {object} res - Response object
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
  var strDn = req.dn.toString();
  req.usersPromise.then(function (users) {
    users.forEach(function (u) {
      if ((req.checkAll || parseDN(strDn).equals(parseDN(u.dn))) && (req.filter.matches(u.attributes))) {
        logDebug(req.site, "MatchUser: " + u.dn);
        res.send(u);
      }
    });
    return next();
  }).catch(function (error) {
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
  var strDn = req.dn.toString();
  req.groupsPromise.then(function (groups) {
    groups.forEach(function (g) {
      if ((req.checkAll || parseDN(strDn).equals(parseDN(g.dn))) && (req.filter.matches(g.attributes))) {
        logDebug(req.site, "MatchGroup: " + g.dn);
        res.send(g);
      }
    });
    return next();
  }).catch(function (error) {
    logError(req.site, "Error while retrieving groups: ", error);
    return next();
  });
}

/**
 * Calls the res.end() function to finalize successful chain processing.
 * @param {object} req - Request object
 * @param {object} res - Response object
 * @param {function} next - Next handler function of filter chain
 */
function endSuccess(_req, res, next) {
  res.end();
  return next();
}

/**
 * Checks the given credentials against the credentials in the config file or against a ChurchTools server.
 * @param {object} req - Request object
 * @param {object} res - Response object
 * @param {function} next - Next handler function of filter chain
 */
function authenticate(req, _res, next) {
  var site = req.site;
  if (req.dn.equals(site.adminDn)) {
    logDebug(site, "Admin bind DN: " + req.dn.toString());
    // If ldap_password is undefined, try a default ChurchTools authentication with this user
    if (site.ldap_password !== undefined) {
      site.checkPassword(req.credentials, function (result) {
        if (result) {
          logDebug(site, "Authentication success");
          return next();
        } else {
          logWarn(site, "Invalid root password!");
          return next(new ldap.InvalidCredentialsError());
        }
      });
      return;
    }
  } else {
    logDebug(site, "Bind user DN: %s", req.dn);
  }
  apiPost(site, "authenticate", {
    "user": req.dn.rdns[0].attrs.cn.value,
    "password": req.credentials
  }).then(function () {
    logDebug(site, "Authentication successful for " + req.dn.toString());
    return next();
  }).catch(function (error) {
    logError(site, "Authentication error: ", error);
    return next(new ldap.InvalidCredentialsError());
  });
}

Object.keys(config.sites).map(function (sitename) {
  // Login bind for user
  server.bind("ou=users,o=" + sitename, function (req, _res, next) {
    req.site = config.sites[sitename];
    next();
  }, authenticate, endSuccess);

  // Search implementation for user search
  server.search("ou=users,o=" + sitename, function (req, _res, next) {
    req.site = config.sites[sitename];
    next();
  }, searchLogging, authorize, function (req, _res, next) {
    logDebug({ sitename: sitename }, "Search for users");
    req.checkAll = req.scope !== "base" && req.dn.rdns.length === 2;
    return next();
  }, requestUsers, sendUsers, endSuccess);

  // Search implementation for group search
  server.search("ou=groups,o=" + sitename, function (req, _res, next) {
    req.site = config.sites[sitename];
    next();
  }, searchLogging, authorize, function (req, _res, next) {
    logDebug({ sitename: sitename }, "Search for groups");
    req.checkAll = req.scope !== "base" && req.dn.rdns.length === 2;
    return next();
  }, requestGroups, sendGroups, endSuccess);

  // Search implementation for user and group search
  server.search("o=" + sitename, function (req, _res, next) {
    req.site = config.sites[sitename];
    next();
  }, searchLogging, authorize, function (req, _res, next) {
    logDebug({ sitename: sitename }, "Search for users and groups combined");
    req.checkAll = req.scope === "sub";
    return next();
  }, requestUsers, requestGroups, sendUsers, sendGroups, endSuccess);
});

// Search implementation for basic search for Directory Information Tree and the LDAP Root DSE
server.search('', function (req, res) {
  logDebug({ sitename: req.dn.o }, "empty request, return directory information");
  var obj = {
    "attributes": {
      "objectClass": ["top", "OpenLDAProotDSE"],
      "subschemaSubentry": ["cn=subschema"],
      "namingContexts": "o=" + req.dn.o,
    },
    "dn": "",
  };

  if (req.filter.matches(obj.attributes))
    res.send(obj);

  res.end();
}, endSuccess);


function escapeRegExp(str) {
  /* JSSTYLED */
  return str.replace(/[\-\[\]\/\{\}\(\)\*\+\?\.\\\^\$\|]/g, '\\$&');
}

/** Case insensitive search on substring filters */
ldap.SubstringFilter.prototype.matches = function (target, strictAttrCase) {
  var tv = helpers.getAttrValue(target, this.attribute, strictAttrCase);
  if (tv !== undefined && tv !== null) {
    var re = '';

    if (this.initial)
      re += '^' + escapeRegExp(this.initial) + '.*';
    this.any.forEach(function (s) {
      re += escapeRegExp(s) + '.*';
    });
    if (this.final)
      re += escapeRegExp(this.final) + '$';

    var matcher = new RegExp(re, 'i');
    return helpers.testValues(function (v) {
      return matcher.test(v);
    }, tv);
  }

  return false;
};


// Start LDAP server
server.listen(parseInt(config.ldap_port), config.ldap_ip, function () {
  console.log('ChurchTools-LDAP-Wrapper listening @ %s', server.url);
});

// ChurchTools LDAP-Wrapper 2.0
// This tool requires a node.js-Server and ChurchTools >= 3.25.0
// (c) 2017 Michael Lux
// License: GNU/GPL v3.0

var ldap = require('ldapjs');
var fs = require('fs');
var ini = require('ini');
var rp = require('request-promise');
var ldapEsc = require('ldap-escape');
var extend = require('extend');
var Promise = require("bluebird");
var path = require('path');

var config = ini.parse(fs.readFileSync(path.resolve(__dirname, 'ctldap.config'), 'utf-8'));
if (config.debug) {
  console.log("Debug mode enabled, expect lots of output!");
}

var fnUserDn = ldapEsc.dn("cn=${cn},ou=users,o=" + config.ldap_base_dn);
var fnGroupDn = ldapEsc.dn("cn=${cn},ou=groups,o=" + config.ldap_base_dn);
var adminDn = fnUserDn({ cn: config.ldap_user });
var cookieJar = rp.jar();
var loginPromise = null;

if (config.dn_lower_case) {
  var compatTransform = function (s) {
    return s.toLowerCase();
  }
} else {
  var compatTransform = function (s) {
    return s;
  }
}

if (config.ldap_cert_filename && config.ldap_key_filename) {
  var ldapCert = fs.readFileSync(config.ldap_cert_filename, {encoding: "utf8"}),
    ldapKey = fs.readFileSync(config.ldap_key_filename, {encoding: "utf8"});
  var server = ldap.createServer({ certificate: ldapCert, key: ldapKey });
} else {
  var server = ldap.createServer();
}

if (typeof config.cache_lifetime !== 'number') {
  config.cache_lifetime = 10000;  // 10 seconds
}
if (config.ct_uri.slice(-1) !== "/") {
  config.ct_uri += "/";
}

/**
 * Returns a promise for the login on the ChurchTools API.
 * If a pending login promise already exists, it is returned right away.
 */
function apiLogin() {
  if (loginPromise === null) {
    if (config.debug) {
      console.log("Performing API login...");
    }
    loginPromise = rp({
      "method": "POST",
      "jar": cookieJar,
      "uri": config.ct_uri + "?q=login/ajax",
      "form": {
        "func": "login",
        "email": config.api_user,
        "password": config.api_password
      },
      "json": true
    }).then(function (result) {
      if (result.status !== "success") {
        throw new Error(result.data);
      }
      if (config.debug) {
        console.log("API login completed");
      }
      // clear login promise
      loginPromise = null;
      // end gracefully
      return null;
    }).catch(function (error) {
      if (config.debug) {
        console.log("API login failed!");
      }
      // clear login promise
      loginPromise = null;
      // rethrow error
      throw new Error(error);
    });
  } else if (config.debug) {
    console.log("Return pending login promise");
  }
  return loginPromise;
}

/**
 * Retrieves data from the PHP API via a POST call.
 * @param {function} func - The function to call in the API class
 * @param {object} [data] - The optional form data to pass along with the POST request
 * @param {boolean} [triedLogin] - Is true if this is the second attempt after API login
 */
function apiPost(func, data, triedLogin) {
  return rp({
    "method": "POST",
    "jar": cookieJar,
    "uri": config.ct_uri + "?q=churchdb/ajax",
    "form": extend({ "func": func }, data || {}),
    "json": true
  }).then(function (result) {
    if (result.status !== "success") {
      // If this was the first attempt, login and try again
      if (!triedLogin) {
        if (config.debug) {
          console.log("Session invalid, login and retry...");
        }
        return apiLogin().then(function () {
          // Retry operation after login
          if (config.debug) {
            console.log("Retry request to API function " + func + " after login");
          }
          // Set "triedLogin" parameter to prevent looping
          return apiPost(func, data, true);
        });
      } else {
        throw new Error(result);
      }
    }
    return result.data;
  }, function (error) {
    console.log(new Error(error));
  });
}

var CACHE = {};
var USERS_KEY = "users", GROUPS_KEY = "groups";

/**
 * Retrieves data from cache as a Promise or refreshes the data with the provided Promise factory.
 * @param {string} key - The cache key
 * @param {number} maxAge - The maximum age of the cache entry, if older the data will be refreshed
 * @param {function} factory - A function returning a Promise that resolves with the new cache entry or rejects
 */
function getCached(key, maxAge, factory) {
  return new Promise(function (resolve, reject) {
    var time = new Date().getTime();
    var co = CACHE[key] || { time: -1, entry: null };
    if (time - maxAge < co.time) {
      resolve(co.entry);
    } else {
      // Call the factory() function to retrieve the Promise for the fresh entry
      // Either resolve with the new entry (plus cache update), or pass on the rejection
      factory().then(function (result) {
        co.entry = result;
        co.time = new Date().getTime();
        CACHE[key] = co;
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
function requestUsers (req, res, next) {
  req.usersPromise = getCached(USERS_KEY, config.cache_lifetime, function () {
    return apiPost("getUsersData").then(function (results) {
      var newCache = results.users.map(function (v) {
        var cn = v.cmsuserid;
        return {
          dn: compatTransform(fnUserDn({ cn: cn })),
          attributes: {
            cn: cn,
            displayname: v.vorname + " " + v.name,
            id: String(v.id),
            uid: cn,
            nsuniqueid: "u" + v.id,
            givenname: v.vorname,
            street: v.street,
            telephoneMobile: v.telefonhandy,
            telephoneHome: v.telefonprivat,
            postalCode: v.plz,
            l: v.ort,
            sn: v.name,
            email: v.email,
            mail: v.email,
            objectclass: ['CTPerson'],
            memberof: (results.userGroups[v.id] || []).map(function (cn) {
              return compatTransform(fnGroupDn({ cn: cn }));
            })
          }
        };
      });
      // add all group to everyone
      newCache.forEach(function (user) {user.attributes.memberof.push(fnGroupDn({cn: "all"})) });
      // Virtual admin user
      if (config.ldap_password !== undefined) {
        var cn = config.ldap_user;
        newCache.push({
          dn: compatTransform(fnUserDn({ cn: cn })),
          attributes: {
            cn: cn,
            displayname: "LDAP Administrator",
            id: 0,
            uid: cn,
            nsuniqueid: "u0",
            givenname: "LDAP Administrator",
          }
        });
      }
      var size = newCache.length;
      if (config.debug && size > 0) {
        console.log("Updated users: " + size);
      }
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
function requestGroups (req, res, next) {
  req.groupsPromise = getCached(GROUPS_KEY, config.cache_lifetime, function () {
    return apiPost("getGroupsData").then(async function (results) {
      var newCache = results.groups.map(function (v) {
        var cn = v.bezeichnung;
        var groupType = v.gruppentyp;
        return {
          dn: compatTransform(fnGroupDn({ cn: cn })),
          attributes: {
            cn: cn,
            displayname: v.bezeichnung,
            id: v.id,
            nsuniqueid: "g" + v.id,
            objectclass: ["group", "CTGroup" + groupType.charAt(0).toUpperCase() + groupType.slice(1)],
            uniquemember: (results.groupMembers[v.id] || []).map(function (cn) {
              return compatTransform(fnUserDn({ cn: cn }));
            })
          }
        };
      });
      // Virtual "all" group
      {
        var cn = "all";
        var reqUsers ={};
        requestUsers(reqUsers, null, function () {});
        // add all group asynchronously
         await reqUsers.usersPromise.then(function (users) {
            newCache.push({
                dn: compatTransform(fnGroupDn({cn: cn})),
                attributes: {
                    cn: cn,
                    displayname: cn,
                    id: 9999990,
                    nsuniqueid: "g" + 9999990,
                    objectclass: ["group", "CTGroup" + cn.charAt(0).toUpperCase() + cn.slice(1)],
                    uniquemember: (users|| []).map(function (user) {
                        return compatTransform(fnUserDn({cn: user.attributes.cn}));
                    })
                }
            });
        });
      }
      var size = newCache.length;
      if (config.debug && size > 0) {
        console.log("Updated groups: " + size);
      }
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
function authorize(req, res, next) {
  if (!req.connection.ldap.bindDN.equals(adminDn)) {
    console.log("Rejected search without proper binding!");
    // return next(new ldap.InsufficientAccessRightsError()); // deactivate this if you also want allow other users to login
  }
  return next();
}

/**
 * Performs debug logging if debug mode is enabled.
 * @param {object} req - Request object
 * @param {object} res - Response object
 * @param {function} next - Next handler function of filter chain
 */
function searchLogging (req, res, next) {
  if (config.debug) {
    console.log("SEARCH base object: " + req.dn.toString() + " scope: " + req.scope);
    console.log("Filter: " + req.filter.toString());
  }
  return next();
}

/**
 * Evaluates req.usersPromise and sends matching elements to the client.
 * @param {object} req - Request object
 * @param {object} res - Response object
 * @param {function} next - Next handler function of filter chain
 */
function sendUsers (req, res, next) {
  var strDn = req.dn.toString();
  req.usersPromise.then(function (users) {
    users.forEach(function (u) {
      if ((req.checkAll || strDn === u.dn) && (req.filter.matches(u.attributes))) {
        if (config.debug) {
          console.log("MatchUser: " + u.dn);
        }
        res.send(u);
      }
    });
    return next();
  }).catch(function (error) {
    console.log("Error while retrieving users: ");
    console.log(new Error(error));
    return next();
  });
}

/**
 * Evaluetes req.groupsPromise and sends matching elements to the client.
 * @param {object} req - Request object
 * @param {object} res - Response object
 * @param {function} next - Next handler function of filter chain
 */
function sendGroups (req, res, next) {
  var strDn = req.dn.toString();
  req.groupsPromise.then(function (groups) {
    groups.forEach(function (g) {
      if ((req.checkAll || strDn === g.dn) && (req.filter.matches(g.attributes))) {
        if (config.debug) {
          console.log("MatchGroup: " + g.dn);
        }
        res.send(g);
      }
    });
    return next();
  }).catch(function (error) {
    console.log("Error while retrieving groups: ");
    console.log(new Error(error));
    return next();
  });
}

/**
 * Calls the res.end() function to finalize successful chain processing.
 * @param {object} req - Request object
 * @param {object} res - Response object
 * @param {function} next - Next handler function of filter chain
 */
function endSuccess (req, res, next) {
  res.end();
  return next();
}

// Login bind for user
server.bind("ou=users,o=" + config.ldap_base_dn, function (req, res, next) {
  if (req.dn.equals(adminDn)) {
    if (config.debug)  {
      console.log('Admin bind DN: ' + req.dn.toString());
    }
    // If ldap_password is undefined, try a default ChurchTools authentication with this user
    if (config.ldap_password !== undefined) {
      if (req.credentials === config.ldap_password) {
        if (config.debug) {
          console.log("Authentication success");
        }
        return next();
      } else {
        console.log("Invalid root password!");
        return next(new ldap.InvalidCredentialsError());
      }
    }
  } else if (config.debug) {
    console.log('Bind user DN: ' + req.dn.toString());
  }
  apiPost("authenticate", {
    "user": req.dn.rdns[0].cn,
    "password": req.credentials
  }).then(function () {
    if (config.debug) {
      console.log("Authentication successful for " + req.dn.toString());
    }
    return next();
  }).catch(function (error) {
    console.log("Authentication error: ");
    console.log(new Error(error));
    return next(new ldap.InvalidCredentialsError());
  });
}, endSuccess);

// Search implementation for user search
server.search("ou=users,o=" + config.ldap_base_dn, searchLogging, authorize, requestUsers, function (req, res, next) {
  if (config.debug) {
    console.log("[DEBUG] request for users " + req);
  }
  req.checkAll = req.scope !== "base";
  return next();
}, sendUsers, endSuccess);

// Search implementation for group search
server.search("ou=groups,o=" + config.ldap_base_dn, searchLogging, authorize, requestGroups, function (req, res, next) {
  if (config.debug) {
    console.log("[DEBUG] request for groups " + req);
  }
  req.checkAll = req.scope !== "base";
  return next();
}, sendGroups, endSuccess);

// Search implementation for user and group search
server.search("o=" + config.ldap_base_dn, searchLogging, authorize, requestUsers, requestGroups, function (req, res, next) {
  if (config.debug) {
    console.log("[DEBUG] request for users and groups combined " + req);
  }
  req.checkAll = req.scope === "sub";
  return next();
}, sendUsers, sendGroups, endSuccess);

// Search implementation for basic search for Directory Information Tree and the LDAP Root DSE
server.search('', function(req, res, next) {
  if (config.debug) {
    console.log("[DEBUG] empty request, return directory information " + req);
  }
  var obj = {
          "attributes":{
            "objectClass":["top", "OpenLDAProotDSE"],
            "subschemaSubentry": ["cn=subschema"],
            "namingContexts": "o=" + config.ldap_base_dn,
	      },
          "dn":"",
  };

  if (req.filter.matches(obj.attributes))
  res.send(obj);

  res.end();
}, endSuccess);

// Start LDAP server
apiLogin().then(function () {
  server.listen(parseInt(config.ldap_port), function () {
    console.log('ChurchTools-LDAP-Wrapper listening @ %s', server.url);
  });
}, function (error) {
  console.log("Error at login to ChurchTools: ");
  console.log(new Error(error));
});


var reqUsers = {};
var reqGroups = {};
requestUsers(reqUsers, null, function() {requestGroups(reqGroups, null, function () {})});

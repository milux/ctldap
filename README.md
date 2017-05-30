# LDAP Wrapper for ChurchTools v1.0.0

This software acts as an LDAP server for ChurchTools version 3.x

**This software was tested in a common environment, yet no warranties of any kind!** 

# Installation
Node.js is required to run this software.
http://nodejs.org/

## Node.js install

### Run the install.sh script as root user. It will
- run "npm install" to install required Node.js dependencies for the server
- create a new user "ctldap" to run the server with limited privileges
- create log/error log files for stdout/stderr output and set the required ownership attributes
- create the configuration file with secure random keys and offer to adapt it, asking for reset if it already exists
- (optionally) adapt and create the ctldap.sh file in /etc/init.d and call "update-rc.d ctldap.sh defaults"

#### ctldap.sh remarks:
The file "ctldap.sh" contains a shell script for (re)starting ctldap.sh with Node.js as a background service.
It will attempt to create/remove an iptables NAT rule on start/stop in order to redirect traffic from a standard LDAP port (< 1024) to ldap_port without root.
The script can be used to start/stop the service manually, but will not work correctly without root privileges.
Usage: ctldap.sh {start|stop|status|restart}

### If you don't have root privileges:
- run `npm install` manually or otherwise trigger the installation of required dependencies
- copy "ctldap.example.config" to "ctldap.config" and adjust the required settings accordingly
- register "ctldap.js" to be run by Node.js, or start the server directly by executing `node ctldap.js`

## PHP API install
- copy the contents of "php_api" to the root folder of your ChurchTools installation (the composer.* files can be safely ignored)
- copy the line "api_key=<random_20_char_string>" from your "ctldap.config" to your ChuchTools configuration at /sites/[default|subdomain]/churchtools.config

# Usage
The LDAP DNs depend on your configuration. We assume the following configuration:
```
ldap_user=root
ldap_password=0a1b2c3d4e5f6g7h8i9j
ldap_base_dn=churchtools
```
For this configuration, the
- admin DN for initial binding is `cn=root,ou=users,o=churchtools`
- password for initial binding is `0a1b2c3d4e5f6g7h8i9j`
- users are found in the organizational unit `ou=users,o=churchtools`
- groups are found in the organizational unit `ou=groups,o=churchtools`
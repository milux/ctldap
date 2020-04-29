# LDAP Wrapper for ChurchTools v2.2.2

This software acts as an LDAP server for ChurchTools >= 3.25.0

**This software was tested in a common environment, yet no warranties of any kind!** 

# Installation
Node.js is required to run this software.
http://nodejs.org/

## Node.js install

### Run the install.sh script as root user. It will
- run "npm install" to install required Node.js dependencies for the server
- create a new user "ctldap" to run the server with limited privileges
- create the configuration file, asking for a reset if it already exists
- *[new config or reset]* ask for the ChurchTools domain (and directory)
- *[new config or reset]* ask for the ChurchTools API user credentials and insert them into the config file
- *[new config or reset]* insert a secure random LDAP root user password into the config file
- *[new config or reset]* offer to customize the config file
- *optionally adapt and create the ctldap.sh file in /etc/init.d and call "update-rc.d ctldap.sh defaults"*

#### ctldap.sh remarks:
The file "ctldap.sh" contains a shell script for (re)starting ctldap.sh with Node.js as a background service, redirecting all output to the system log with systemd-cat. The logs can be reviewed with the shell command `journalctl -t ctldap`. See https://wiki.ubuntuusers.de/systemd/journalctl/ for further options.

The script will attempt to create/remove an iptables NAT rule on start/stop in order to redirect traffic from a standard LDAP port (< 1024) to ldap_port without root.

It can be used to start/stop the service manually, but will not work correctly without root privileges!

Usage: ctldap.sh {start|stop|status|restart}

### If you don't have root privileges:
- run `yarn install` or `npm install` manually or otherwise trigger the installation of required dependencies
- copy "ctldap.example.config" to "ctldap.config" and adjust the required settings accordingly
- register "ctldap.js" to be run by Node.js, or start the server directly by executing `node ctldap.js`

# Usage
The LDAP DNs depend on your configuration. Let's assume the following configuration:
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
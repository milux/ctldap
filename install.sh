#!/bin/bash

# ChurchTools LDAP-Wrapper 2.0
# (c) 2017 Michael Lux <michi.lux@gmail.com>
# License: GNU/GPL v3.0

if [ "$(id -u)" != "0" ]; then
   echo "This script must be run as root!" 1>&2
   exit 1
fi

CTLDAP=$( dirname "$0" )
cd "$CTLDAP"
CTLDAP=$( pwd )
echo "Create init script $CTLDAP/ctldap.sh..."
cat ctldap_raw.sh | sed "s/#CTLDAP#/${CTLDAP//\//\\/}/" > ctldap.sh
echo ""

echo "Running \"npm_install\" to download required node.js packages..."
npm install
echo ""

echo "Now creating the \"ctldap\" user..."
useradd ctldap
echo ""

ANSWER="y"
if [ -f "ctldap.config" ]; then
    read -n1 -p "Reset configuration file? [y/n]" ANSWER
    echo ""
fi
if [ $ANSWER = "y" ]; then
    PRNG_PASSWORD=$(tr -cd '[:alnum:]' < /dev/urandom | fold -w20 | head -n1)
    echo ""
    echo "The new password for the LDAP root user is: $PRNG_PASSWORD"
    echo ""
    read -r -p "Please enter the domain (and directory) of your ChurchTools installation (example: mychurch.church.tools): " CTLOC
    echo "Assumed (HTTPS) ChurchTools URL: https://$CTLOC/"
    echo "If this is wrong, please fix it manually when the configuration file is opened for customization."
    echo ""
    read -r -p "Please enter ChurchTools username for authentication: " USERNAME
    read -r -p "Please enter ChurchTools user password for authentication: " PASSWORD
    cat ctldap.example.config | \
    sed "s?mysite.church.tools?$CTLOC?" | \
    sed "s/ldap_password=XXXXXXXXXXXXXXXXXXXX/ldap_password=$PRNG_PASSWORD/" | \
    sed "s/api_user=XXXXXXXXXXXXXXXXXXXX/api_user=$USERNAME/" | \
    sed "s/api_password=XXXXXXXXXXXXXXXXXXXX/api_password=$PASSWORD/" > ctldap.config
    echo ""
    echo "Don't forget to grant your ChurchTools API user this privileges:"
    echo "- churchcore:administer persons (Required to access the user data)"
    echo "- churchdb:view (Required for ChurchDB API access)"
    echo ""
fi

echo "Trying to open ctldap.config now, modify it according to your needs!"
read -n1 -r -p "Press any key to continue..."
if [[ $(which nano) = /* ]]; then
    nano ctldap.config
elif [[ $(which vim) = /* ]]; then
    vim ctldap.config
fi
echo ""

read -n1 -p "Register ctldap.sh for autostart at /etc/init.d? [y/n]" ANSWER
if [ $ANSWER = "y" ]; then
    cp -f ctldap.sh /etc/init.d/
    chmod +x /etc/init.d/ctldap.sh
    update-rc.d ctldap.sh defaults
fi
echo ""
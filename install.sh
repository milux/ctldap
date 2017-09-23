#!/bin/bash

# ChurchTools 3.2 LDAP-Wrapper
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

echo "Init logging files..."
touch output.log
touch error.log
chown ctldap:ctldap *.log
echo ""

ANSWER="y"
if [ -f "ctldap.config" ]; then
    read -n1 -p "Reset configuration file? [y/n]" ANSWER
    echo ""
fi
if [ $ANSWER = "y" ]; then
    PRNG_CMD="tr -cd '[:alnum:]' < /dev/urandom | fold -w20 | head -n1"
    cat ctldap.example.config | \
    sed "s/ldap_password=XXXXXXXXXXXXXXXXXXXX/ldap_password=$(eval ${PRNG_CMD})/" | \
    sed "s/api_key=XXXXXXXXXXXXXXXXXXXX/api_key=$(eval ${PRNG_CMD})/" > ctldap.config
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
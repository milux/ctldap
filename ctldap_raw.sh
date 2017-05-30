#!/bin/sh

### BEGIN INIT INFO
# Provides:          ctldap
# Required-Start:    $remote_fs $syslog
# Required-Stop:     $remote_fs $syslog
# Default-Start:     2 3 4 5
# Default-Stop:      0 1 6
# Short-Description: ChurchTools 3.2 LDAP-Wrapper
# Description:       Init script for the ChurchTools LDAP Wrapper.
### END INIT INFO

# Author: Michael Lux <michi.lux@gmail.com>
# License: GNU/GPL v3.0

NAME="ctldap"
DESC="ChurchTools LDAP Wrapper"

PIDFILE="/var/run/$NAME.pid"
CTLDAP="#CTLDAP#"
PATH=/sbin:/usr/sbin:/bin:/usr/bin

case "$1" in
start)
	echo "Starting $NAME..."
    if [ -f $PIDFILE ]; then
        echo "Found PID file, try to stop first..."
        if echo "$0" | grep -qe "^/"; then
            $0 stop
        else
            DIR=$(dirname "$0")
            sh $DIR/$0 stop
        fi
    fi
    su -c "nohup node $CTLDAP/ctldap.js 2>>$CTLDAP/error.log >>$CTLDAP/output.log &" - ctldap
    PID=$( ps axf | grep "node $CTLDAP/ctldap.js" | grep -v grep | awk '{print $1}' )
    if [ -z "$PID" ]; then
        echo "Fail"
    else
        echo $PID > $PIDFILE
        echo "$DESC started"
        DPORT=$( cat $CTLDAP/ctldap.config | grep -oP "(?<=iptables_port=)[1-9][0-9]+" | head -n1 )
        if [ -n "$DPORT" ]; then
            echo "Trying to create iptables NAT rules for port redirect..."
            TO_PORT=$( cat $CTLDAP/ctldap.config | grep -oP "(?<=ldap_port=)[1-9][0-9]+" | head -n1 )
            iptables -A PREROUTING -t nat -i eth0 -p tcp --dport "$DPORT" -j REDIRECT --to-port "$TO_PORT"
        fi
    fi
;;

status)
    echo "Checking $NAME..."
    if [ -f $PIDFILE ]; then
        PID=`cat $PIDFILE`
        if [ -z "`ps axf | grep ${PID} | grep -v grep`" ]; then
            echo "$NAME dead but pidfile exists"
        else
            echo "$NAME running"
        fi
    else
        echo "$NAME not running"
    fi
;;

stop)
    echo "Stopping $NAME..."
    PID=`cat $PIDFILE`
    if [ -f $PIDFILE ]; then
        kill -HUP $PID
        echo "$DESC stopped"
        DPORT=$( cat $CTLDAP/ctldap.config | grep -oP "(?<=iptables_port=)[1-9][0-9]+" | head -n1 )
        if [ -n "$DPORT" ]; then
            echo "Trying to remove iptables NAT rules..."
            TO_PORT=$( cat $CTLDAP/ctldap.config | grep -oP "(?<=ldap_port=)[1-9][0-9]+" | head -n1 )
            iptables -D PREROUTING -t nat -i eth0 -p tcp --dport "$DPORT" -j REDIRECT --to-port "$TO_PORT"
        fi
        rm -f $PIDFILE
    else
        echo "pidfile not found"
    fi
;;

restart|reload|force-reload)
    if echo "$0" | grep -qe "^/"; then
        $0 stop
        $0 start
    else
        DIR=$(dirname "$0")
        sh $DIR/$0 stop
        sh $DIR/$0 start
    fi

;;

*)
    echo "Usage: $0 {start|stop|status|restart}"
    exit 1
esac
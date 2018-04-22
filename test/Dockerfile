FROM alpine
MAINTAINER Simon Scholl <s@sdscholl.de>

RUN apk --no-cache add openldap-clients

ENV LDAP_USER root
ENV LDAP_PW XXXXXXXXXXXXXXXXXXXX
ENV LDAP_PORT 1389
ENV LDAP_BASE_DN churchtools

CMD echo "[INFO] test the LDAP server with following command:" && \
    echo "docker-compose run test ldapsearch -H ldap://ldap:${LDAP_PORT} -x -D cn=${LDAP_USER},ou=users,o=${LDAP_BASE_DN} -w ${LDAP_PW} -LLL -b o=${LDAP_BASE_DN}  '(&(&(objectclass=ctperson))(|(cn=*test*)(mail=*test*)))'"

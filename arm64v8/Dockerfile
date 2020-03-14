FROM alpine AS qemu

# QEMU Download, see https://github.com/docker/hub-feedback/issues/1261
ENV QEMU_URL https://github.com/balena-io/qemu/releases/download/v3.0.0%2Bresin/qemu-3.0.0+resin-aarch64.tar.gz
RUN apk add curl && curl -L ${QEMU_URL} | tar zxvf - -C . --strip-components 1

# Build from parent directory with this command:
# docker build -t milux/ctldap:arm64v8-latest -f ./arm64v8/Dockerfile .

FROM arm64v8/node:12-alpine
LABEL maintainer="Michael Lux <michi.lux@gmail.com>"

COPY --from=qemu qemu-arm-static /usr/bin

RUN mkdir /app && chown node:node /app
USER node
WORKDIR /app

COPY . .
RUN yarn install

EXPOSE 1389

ENV DEBUG false
ENV IS_DN_LOWER_CASE true
ENV LDAP_USER root
ENV LDAP_PW XXXXXXXXXXXXXXXXXXXX
ENV LDAP_PORT 1389
ENV LDAP_BASE_DN churchtools
ENV CT_URI https://mysite.church.tools/
ENV CT_USER XXXXXXXXXXXXXXXXXXXX
ENV CT_PW XXXXXXXXXXXXXXXXXXXX
ENV CACHE_LIVETIME 10000

# Update config by environment variables and start ctldap server
CMD cp ctldap.example.config ctldap.config && \
    sed -i "s/^\(debug\s*=\s*\).*\$/\1$DEBUG/" ctldap.config && \
    sed -i "s/^\(dn_lower_case\s*=\s*\).*\$/\1$IS_DN_LOWER_CASE/" ctldap.config && \
    sed -i "s/^\(ldap_user\s*=\s*\).*\$/\1$LDAP_USER/" ctldap.config && \
    sed -i "s/^\(ldap_password\s*=\s*\).*\$/\1$LDAP_PW/" ctldap.config && \
    sed -i "s/^\(ldap_ip\s*=\s*\).*\$/\10.0.0.0/" ctldap.config && \
    sed -i "s/^\(ldap_port\s*=\s*\).*\$/\1$LDAP_PORT/" ctldap.config && \
    sed -i "s/^\(ldap_base_dn\s*=\s*\).*\$/\1$LDAP_BASE_DN/" ctldap.config && \
    sed -i "s#^\(ct_uri\s*=\s*\).*\$#\1$CT_URI#" ctldap.config && \
    sed -i "s/^\(api_user\s*=\s*\).*\$/\1$CT_USER/" ctldap.config && \
    sed -i "s/^\(api_password\s*=\s*\).*\$/\1$CT_PW/" ctldap.config && \
    sed -i "s/^\(cache_lifetime\s*=\s*\).*\$/\1$CACHE_LIVETIME/" ctldap.config && \
    node ctldap.js

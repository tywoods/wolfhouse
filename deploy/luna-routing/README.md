# Luna routing controller deployment contract

The controller is a loopback-only TLS service running as the dedicated, non-login
`luna-routing` user. It is not a network daemon running as root. State (lock,
ledger, journal, candidates, and backups) belongs under `/var/lib/luna-routing`;
set controller paths there when constructing the service controller. The service
may replace `/etc/caddy/Caddyfile` only when that file and its parent permissions
permit it, and preserves its uid, gid, and mode. The only privilege bridge is the
literal noninteractive command `/usr/bin/sudo -n /usr/bin/systemctl reload caddy`.

Install the unit, environment file, tmpfiles entry, and sudoers file with the
modes checked by `install-luna-routing.sh`. Put the TLS private key at
`/etc/luna-routing/tls/controller.key`, owner `root:luna-routing`, mode `0640`;
the certificate may be `0644`. Run the installer with `--verify` before enabling.

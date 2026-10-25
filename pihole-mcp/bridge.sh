#!/bin/sh
# Runs only inside the selected Pi-hole container; stdout is response + HTTP code.
set -eu
method=$1
path=$2
body=$3
port=$4
deadline=$5
base="http://127.0.0.1:${port}/api"

if [ ! -r /etc/pihole/cli_pw ]; then
    echo 'Pi-hole CLI authentication is unavailable. Enable CLI authentication in Pi-hole.' >&2
    exit 1
fi

# Neither the CLI credential nor the session is returned to the host.
auth=$(jq -n --rawfile password /etc/pihole/cli_pw '{password: ($password | rtrimstr("\n"))}' |
    curl --silent --show-error --fail --connect-timeout 3 --max-time 10 \
        --header 'Content-Type: application/json' --data-binary @- "${base}/auth")
sid=$(printf '%s' "${auth}" | jq -er '.session | select(.valid == true) | .sid | select(type == "string" and length > 0)')
unset auth
cleanup() {
    curl --silent --max-time 5 --request DELETE --header "sid: ${sid}" \
        "${base}/auth" >/dev/null 2>&1 || :
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
printf '%s' "${body}" | curl --silent --show-error --connect-timeout 3 --max-time "${deadline}" \
    --request "${method}" --header "sid: ${sid}" --header 'Content-Type: application/json' \
    --data-binary @- --write-out '\n%{http_code}' "${base}/${path}"

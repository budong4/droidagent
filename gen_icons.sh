#!/bin/bash
mkdir -p /tmp/icons
rsvg-convert -w 48 -h 48 /usr/local/share/agent-app/web/icon.svg -o /tmp/icons/icon_48.png
rsvg-convert -w 72 -h 72 /usr/local/share/agent-app/web/icon.svg -o /tmp/icons/icon_72.png
rsvg-convert -w 96 -h 96 /usr/local/share/agent-app/web/icon.svg -o /tmp/icons/icon_96.png
rsvg-convert -w 144 -h 144 /usr/local/share/agent-app/web/icon.svg -o /tmp/icons/icon_144.png
rsvg-convert -w 192 -h 192 /usr/local/share/agent-app/web/icon.svg -o /tmp/icons/icon_192.png
rsvg-convert -w 512 -h 512 /usr/local/share/agent-app/web/icon.svg -o /tmp/icons/icon_512.png
ls -l /tmp/icons

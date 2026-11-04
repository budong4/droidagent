#!/system/bin/sh
# Optional: start the phone agent's web terminal at boot (KernelSU service.d).
# Install:  cp 99-debian-agent.sh /data/adb/service.d/ && chmod 755 /data/adb/service.d/99-debian-agent.sh
# Remove:   rm /data/adb/service.d/99-debian-agent.sh
#
# The rootfs lives in the app's device-encrypted storage (/data/user_de/0/<pkg>), so it belongs
# to the APK and is still readable before the first unlock — /data/data would not be.
until [ "$(getprop sys.boot_completed)" = 1 ]; do sleep 5; done
sleep 20
/data/user_de/0/com.droidagent.app/bin/debian app start > /data/local/tmp/debian-agent-boot.log 2>&1

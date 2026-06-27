# Railway persistent data

This app stores live meals, places, and orders in `kitchen-data.json`.

On Railway, attach a Volume to the service so this file is stored outside the deployed app image and survives redeploys.

Recommended setup:

1. Open the Railway project.
2. Add or attach a Volume to the app service.
3. Set the Volume mount path to `/data`.
4. Redeploy the service.

The server automatically uses `RAILWAY_VOLUME_MOUNT_PATH` when Railway provides it, so no extra environment variable is needed.

Without a Railway Volume, data added from the live site can be lost after a push, commit, redeploy, or service restart.

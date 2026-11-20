# Homebridge Mammotion

[![license-mit](https://badgen.net/static/license/mit/blue)](https://github.com/willmot/homebridge-mammotion/blob/main/LICENSE)

Control Mammotion mowers through the [official Mammotion API](https://developer.mammotion.com/docs).
Each mower appears as a Matter robotic vacuum when Homebridge supports Matter, with a HomeKit switch fallback.
The existing mower tile supports start/resume, pause, return to dock and task stop, with battery level, charging and fault status. Status is read from the API at the configured polling interval.

## Requirements

- Node.js 20.12+
- Homebridge 1.8+, or a Matter-capable Homebridge 2 installation for robotic vacuum accessories
- A supported mower linked to a Mammotion account with developer credentials

Python and PyMammotion are not required.

## Install and configure

```sh
npm install -g homebridge-mammotion
```

[Create developer credentials](https://developer.mammotion.com/docs/create-credentials) for the account linked to your mower. Save them when issued and check their expiry in the developer portal.
Save them in a private file outside the repository, readable by the Homebridge service user:

```dotenv
MAMMOTION_CLIENT_ID="your-client-id"
MAMMOTION_CLIENT_SECRET="your-client-secret"
```

Restrict access to the file (`chmod 600 /absolute/path/to/mammotion.env`), then configure:

```json
{
  "platform": "Mammotion",
  "apiCredentialsPath": "/absolute/path/to/mammotion.env",
  "pollIntervalSeconds": 15,
  "enableMatterRvc": true,
  "offCommand": "pause"
}
```

`deviceFilter` optionally limits discovery to exact device names. `offCommand` selects `pause`, `dock`, or `cancel` for the HomeKit switch.
`cancel` terminates the current task. In Matter mode, Idle also terminates the task; Return to Dock uses the separate docking command. Start resumes a paused task; otherwise it uses the API's direct-start command with no saved-plan requirement.
Command acceptance does not guarantee movement: mower locks, firmware, map readiness, and device errors still apply.
Failed commands are not automatically replayed. Rate-limit responses delay subsequent requests.

Battery readings use the native Matter Power Source cluster. A paused task stays in Cleaning run mode so the Home app can offer Resume. No extra accessories are created. Saved-task selection and Cancel Return have no matching control in the mower tile. Cutting height, speed and work parameters are read-only in the official API; configure them in the Mammotion app.

## Migrating an existing pairing

Keep the existing `platform`, `name`, `email`, `_bridge`, device names, and Homebridge Matter storage unchanged.
The old `email` value remains an accessory identity seed; it is no longer used to authenticate.
Add `apiCredentialsPath`, then remove `password`, `pythonPath`, and `areaNameFallbacks`.
Prepare the credentials before updating so the plugin can reconnect on restart.
Keep the mower paired in Apple Home.

## Verify API access

```sh
node "$(npm root -g)/homebridge-mammotion/scripts/probe-official-api.js" /absolute/path/to/mammotion.env
```

This uses the plugin's client to read mower status without sending commands or opening an SSE subscription.
The plugin uses REST polling; it does not change account-wide push subscriptions.
If the official API omits live status or battery data while the mower is asleep, the plugin reports the mower as unavailable until fresh telemetry returns.

## Development

```sh
npm ci
npm run lint
npm test
```

Tests build the plugin, check types, exercise authentication and command failures, validate Matter endpoints on a simulated network, and unpack the npm package.

## Credits

- [Mammotion Developer](https://developer.mammotion.com/docs) provides the official API.
- Reliability and packaging work was informed by [homebridge-mammotion-ng](https://github.com/7onnie/homebridge-mammotion-ng) by `7onnie`.
- The original PyMammotion integration was informed by the [Mammotion Home Assistant integration](https://github.com/mikey0000/Mammotion-HA) by `mikey0000` and the [Mammotion Yuka Apple Home guide](https://www.reddit.com/r/HomeKit/comments/1rkvbyu/mammotion_yuka_in_apple_home_with_zone_selection/).

## License

Licensed under the MIT License. See [LICENSE](./LICENSE).

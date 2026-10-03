# Speedrun Server

A Minecraft 26.3 server for speedrunning, with a live dashboard.

Everything runs on **one port, 25560**:

- **Play:** in Minecraft, go to Multiplayer and add `localhost:25560`.
- **Watch:** open <http://localhost:25560> in a browser.

The dashboard shows each player's speedrun timer and splits (Nether, blaze
rods, eyes of ender, the End, the dragon), their health, food, XP,
coordinates (with the matching Nether/Overworld spot), speedrun items and
inventory, plus the world's seed, day, time, difficulty and a feed of chat,
deaths and advancements.

## Start it

```bash
docker compose up -d --build
```

The world lives in a Docker volume, so it survives restarts.

## How it works

`dashboard/server.js` listens on 25560 and checks the first bytes of each
connection. Browsers get the dashboard; Minecraft clients are passed through
to the real server. It reads the game over RCON once a second. The timer is
the player's in-game play time.

`tools/make_icon.py` draws `server-icon.png`.

Made by Elduin.

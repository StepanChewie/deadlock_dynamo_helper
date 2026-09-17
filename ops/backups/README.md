# Database backups

A nightly, verified logical backup of `deadlock_builds`, installed as a systemd
timer. Added 2026-09-16, when the answer to "what happens if someone drops a
table" was "it is gone".

## What it does

1. `pg_dump -Fc` of the whole database, executed inside the postgres container
   (no client needed on the host).
2. **Verifies** the archive with `pg_restore --list` and requires at least one
   `TABLE DATA` entry. A dump that died halfway is deleted, not kept.
3. Moves the dump to `/var/backups/deadlock/` and keeps the newest 7.
4. Logs one line to the journal on success, and posts to the same Discord
   webhook as the health watcher on failure.

**Why a full dump and not schema-only.** The roadmap proposed schema-only
because `adaptive_recommendation_decisions_v1` held 73 GB of TOAST. That table is
now 56 kB and the entire database is ~125 MB across 32 tables (largest:
`statlocker_vs_hero_wpa_rows_v1`, 78 MB), so a complete compressed dump costs
almost nothing and is far more useful.

## Install

```bash
sudo install -m 0755 ops/backups/deadlock-db-backup.sh /usr/local/bin/
sudo install -m 0644 ops/backups/deadlock-db-backup.service /etc/systemd/system/
sudo install -m 0644 ops/backups/deadlock-db-backup.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now deadlock-db-backup.timer
```

The `Deploy API` workflow runs these steps on every deploy, so a change to this
directory reaches the server by itself. Before that, the files were copied by
hand and the repository could drift from the machine.

## Configuration

Optional, in `/etc/deadlock-db-backup.env`. The file is sourced **before** the
defaults are resolved, so values set here win:

```bash
DEADLOCK_BACKUP_DIR=/var/backups/deadlock
DEADLOCK_BACKUP_KEEP=7
DEADLOCK_BACKUP_CONTAINER=aboba-telegramovich-postgres-1
```

`DISCORD_WEBHOOK_URL` is **not** duplicated here: the script falls back to
reading it from `/etc/deadlock-health-watch.env`, so rotating the webhook stays a
one-place change.

## Run it by hand

```bash
sudo systemctl start deadlock-db-backup.service
journalctl -t deadlock-db-backup -n 20 --no-pager
ls -lh /var/backups/deadlock/
```

To exercise the failure path without touching the real database, point it at a
container that does not exist:

```bash
sudo DEADLOCK_BACKUP_CONTAINER=does-not-exist \
  DEADLOCK_BACKUP_TEST_ALERT=1 \
  /usr/local/bin/deadlock-db-backup.sh
```

**This posts a real alert to the production Discord channel.** That is the point
of running it — an alert path that has never delivered anything is not known to
work. `DEADLOCK_BACKUP_TEST_ALERT=1` marks it as a test so it cannot be mistaken
for an incident; **without that variable the alert is word-for-word identical to
a genuine failure.** On 2026-09-16 a verification run at 20:59 UTC did exactly
that, and the resulting alert was reported back as a real backup failure. The
marker appears in the journal line too, so either place identifies it.

## Restoring

**Rehearsed end to end on 2026-09-17 against the 2026-09-16 dump.** Restoring
into a scratch database reproduced **32 tables against 32 live, `pg_restore`
exit 0, zero errors**, with row counts matching exactly for every table checked
(`adaptive_build_iterations_v1` 99, `build_archetype_match_locks_v2` 7,
`statlocker_vs_hero_wpa_rows_v1` 173 496). `item_catalog_items` restored 2 904
rows against 3 630 live, which is expected rather than a fault: that table is
refreshed periodically and a dump is a point-in-time snapshot. The scratch
database was dropped afterwards.

The commands:

```bash
# Inspect first: this lists the archive contents without touching anything.
docker exec -i aboba-telegramovich-postgres-1 pg_restore --list < /var/backups/deadlock/<file>.dump

# Restore into a scratch database, never over the live one.
docker exec -i aboba-telegramovich-postgres-1 \
  createdb -U postgres deadlock_restore_check
docker exec -i aboba-telegramovich-postgres-1 \
  pg_restore -U postgres -d deadlock_restore_check --no-owner < /var/backups/deadlock/<file>.dump
docker exec aboba-telegramovich-postgres-1 \
  dropdb -U postgres deadlock_restore_check
```

One trap worth knowing when scripting this: `docker exec -i` attaches the
caller's stdin, so if the script itself is being piped in (`ssh host bash -s <
script.sh`) the first interactive exec swallows the rest of the script. Give
`-i` only to the command that actually reads stdin (`pg_restore`).

## Known gap: these dumps are on the same disk as the database

A dump on the same host protects against a dropped table, a bad migration or an
accidental `DELETE` — the common causes. It does **not** protect against losing
the machine. An off-site copy (object storage, another host, or even a pull from
the operator's machine) is still needed, and the destination is an owner
decision, which is why it is not guessed at here.

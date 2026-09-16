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
sudo DEADLOCK_BACKUP_CONTAINER=does-not-exist /usr/local/bin/deadlock-db-backup.sh
```

## Restoring

Not yet rehearsed end to end — treat that as an open item. The command is:

```bash
# Inspect first: this lists the archive contents without touching anything.
docker exec -i aboba-telegramovich-postgres-1 pg_restore --list < /var/backups/deadlock/<file>.dump

# Restore into a scratch database, never over the live one.
docker exec -i aboba-telegramovich-postgres-1 \
  createdb -U postgres deadlock_restore_check
docker exec -i aboba-telegramovich-postgres-1 \
  pg_restore -U postgres -d deadlock_restore_check --no-owner < /var/backups/deadlock/<file>.dump
```

## Known gap: these dumps are on the same disk as the database

A dump on the same host protects against a dropped table, a bad migration or an
accidental `DELETE` — the common causes. It does **not** protect against losing
the machine. An off-site copy (object storage, another host, or even a pull from
the operator's machine) is still needed, and the destination is an owner
decision, which is why it is not guessed at here.

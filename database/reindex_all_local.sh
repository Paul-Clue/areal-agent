#!/usr/bin/env bash
# Rebuild all indexes on the local PostgreSQL instance (e.g. Postgres.app after
# macOS upgrade / “Reindexing required” warning). Requires reindexdb on PATH.
# See docs/databasePlanv2.md — Appendix: Postgres.app reindex.
set -euo pipefail
: "${PGPORT:=5432}"
reindexdb --all --echo

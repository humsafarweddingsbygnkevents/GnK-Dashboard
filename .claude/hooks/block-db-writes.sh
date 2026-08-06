#!/usr/bin/env bash
# PreToolUse/Bash guard for the Humsafar GnK Dashboard.
#
# backend/.env points at the LIVE Neon production database. There is no staging
# copy and no automatic backup. On 2026-08-06 a `prisma migrate diff` run with
# the production URL as --shadow-database-url dropped every table (Prisma resets
# the shadow database), destroying hotels, clients, attendance, feedback and
# messages. This hook makes that class of command impossible to run by accident.
#
# Default is ALLOW. Only commands matching a destructive pattern are denied.
# Reads (count/findMany/findUnique/SELECT) are deliberately untouched.
#
# To run a blocked command deliberately: the user runs it themselves from the
# input box with a leading `!`, or temporarily disables this hook via /hooks.

set -uo pipefail

payload="$(cat)"
cmd="$(printf '%s' "$payload" | jq -r '.tool_input.command // empty' 2>/dev/null)"

[ -z "$cmd" ] && exit 0

deny() {
  jq -nc --arg reason "$1" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $reason
    }
  }'
  exit 0
}

# Collapse whitespace so multi-line / oddly-spaced commands still match.
flat="$(printf '%s' "$cmd" | tr '\n\t' '  ')"

# --- Prisma schema/data mutations ------------------------------------------
# `prisma migrate ...` and `prisma db ...` cover dev, reset, deploy, diff,
# push, execute and seed. `prisma generate` and `prisma validate` are safe and
# intentionally NOT matched.
if printf '%s' "$flat" | grep -qEi '(^|[^a-z-])prisma[[:space:]]+(migrate|db)([[:space:]]|$)'; then
  deny "BLOCKED: prisma migrate/db writes to the live production database (backend/.env -> Neon). There is no staging copy and no automatic backup. If this is genuinely needed, ask the user and let them run it themselves."
fi

# The specific command that caused the 2026-08-06 data loss. Prisma RESETS the
# shadow database — passing a real database URL here destroys it.
if printf '%s' "$flat" | grep -qEi '\-\-shadow-database-url'; then
  deny "BLOCKED: --shadow-database-url. Prisma DROPS AND RECREATES whatever database is passed here. This exact command wiped production on 2026-08-06. To compare migrations against the schema, read the .sql files and schema.prisma directly instead."
fi

# --- npm database scripts ---------------------------------------------------
# db:seed starts with hotel.deleteMany() + city.deleteMany(); db:reset drops
# everything; db:migrate runs `migrate dev`.
if printf '%s' "$flat" | grep -qEi 'db:(seed|reset|migrate)'; then
  deny "BLOCKED: db:seed / db:reset / db:migrate are destructive. prisma/seed.js opens with hotel.deleteMany() and city.deleteMany() — it is a wipe-and-reload, not an additive import. Ask the user first."
fi

# --- Scripts that write ------------------------------------------------------
if printf '%s' "$flat" | grep -qEi '(prisma/)?seed\.js|bootstrapAdmin(\.js)?'; then
  deny "BLOCKED: this script writes to the production database. Ask the user, and prefer that they run it themselves so they capture any generated credentials."
fi

# --- Prisma Client write methods in inline node/npx scripts ------------------
if printf '%s' "$flat" | grep -qEi '\.(create|createMany|update|updateMany|upsert|delete|deleteMany)[[:space:]]*\('; then
  deny "BLOCKED: Prisma Client write method (create/update/delete/upsert). Read-only calls — count, findMany, findUnique, findFirst — are allowed. Ask the user before writing."
fi

if printf '%s' "$flat" | grep -qEi '\$executeRaw|executeRawUnsafe'; then
  deny "BLOCKED: \$executeRaw executes arbitrary SQL. Use \$queryRaw with a SELECT for reads."
fi

# --- Raw SQL DDL/DML ---------------------------------------------------------
if printf '%s' "$flat" | grep -qEi '(DROP[[:space:]]+(TABLE|DATABASE|SCHEMA|COLUMN)|TRUNCATE([[:space:]]+TABLE)?|DELETE[[:space:]]+FROM|INSERT[[:space:]]+INTO|UPDATE[[:space:]]+["a-zA-Z_]+[[:space:]]+SET|ALTER[[:space:]]+TABLE|CREATE[[:space:]]+(TABLE|DATABASE))'; then
  deny "BLOCKED: destructive SQL (DROP/TRUNCATE/DELETE/INSERT/UPDATE/ALTER/CREATE) against the production database. SELECT is allowed."
fi

# psql opens an arbitrary session against production; deny wholesale.
if printf '%s' "$flat" | grep -qEi '(^|[^a-z-])psql([[:space:]]|$)'; then
  deny "BLOCKED: psql opens an interactive session against the production database. For read-only inspection use Prisma Client with count/findMany/\$queryRaw + SELECT."
fi

exit 0

#!/bin/zsh
cd -- "${0:A:h}" || exit 1
if python3 backend/tools/connect_telegram.py --config wrangler.production.jsonc; then
  python3 backend/tools/enable_statuses.py --config wrangler.production.jsonc
fi
printf '\nНажмите Enter, чтобы закрыть окно…'
read -r

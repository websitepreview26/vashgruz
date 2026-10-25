#!/bin/zsh
cd -- "${0:A:h}" || exit 1
python3 backend/tools/connect_telegram.py
printf '\nНажмите Enter, чтобы закрыть окно…'
read -r

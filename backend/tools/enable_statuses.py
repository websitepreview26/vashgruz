#!/usr/bin/env python3
"""Configure Telegram callbacks using the bot token already stored in the Worker."""
import json
import os
import secrets
import subprocess
import sys
import time

sys.dont_write_bytecode = True
from connect_telegram import ACCOUNT_ID, ROOT, WORKER_URL, runtime


def main():
    cli = runtime()
    env = {**os.environ, "WRANGLER_SEND_METRICS": "false", "WRANGLER_LOG_PATH": os.devnull, "CLOUDFLARE_ACCOUNT_ID": ACCOUNT_ID}
    for key in ("CLOUDFLARE_API_TOKEN", "CLOUDFLARE_API_KEY", "CLOUDFLARE_EMAIL"):
        env.pop(key, None)
    who = subprocess.run(cli + ["whoami", "--json"], cwd=ROOT, env=env, capture_output=True, text=True)
    try:
        account = json.loads(who.stdout)
        if who.returncode or not any(a["id"] == ACCOUNT_ID for a in account.get("accounts", [])):
            raise ValueError()
    except (ValueError, KeyError):
        raise SystemExit("Неверный профиль Cloudflare. Настройка остановлена.")
    admin_key = secrets.token_urlsafe(40)
    webhook_key = secrets.token_urlsafe(40)
    result = subprocess.run(cli + ["secret", "bulk"], input=json.dumps({"ADMIN_SETUP_SECRET": admin_key, "TELEGRAM_WEBHOOK_SECRET": webhook_key}), cwd=ROOT, env=env, capture_output=True, text=True)
    if result.returncode:
        raise SystemExit("Не удалось настроить секреты webhook. Значения скрыты.")
    # Secret headers travel via stdin, never command arguments, source files or logs.
    source = """
const fs=require('node:fs');const d=JSON.parse(fs.readFileSync(0,'utf8'));
fetch(d.url,{method:'POST',headers:{authorization:'Bearer '+d.key,'content-type':'application/json'},body:JSON.stringify(d.body),signal:AbortSignal.timeout(90000)})
.then(async r=>{const data=await r.json();console.log(JSON.stringify(data));if(!r.ok)process.exitCode=1})
.catch(()=>{console.log(JSON.stringify({ok:false,message:'Не удалось связаться с Worker.'}));process.exitCode=1});
"""

    def call(body):
        payload = json.dumps({"url": WORKER_URL + "/internal/telegram/setup", "key": admin_key, "body": body})
        for attempt in range(7):
            r = subprocess.run([cli[0], "-e", source], input=payload, capture_output=True, text=True, timeout=95)
            try:
                data = json.loads(r.stdout)
            except ValueError:
                raise SystemExit("Worker не подтвердил настройку. Секреты не выводятся.")
            # Secret updates can reach the nearest edge slightly later than the CLI response.
            if data.get("code") == "SETUP_AUTH" and attempt < 6:
                time.sleep(attempt + 1)
                continue
            break
        if r.returncode or not data.get("ok"):
            raise SystemExit(data.get("message", "Настройка не завершена."))
        return data

    setup = call({"action": "setup"})
    if not setup.get("webhook"):
        raise SystemExit("Telegram не подтвердил webhook.")
    print("Webhook подключён и подтверждён Telegram.")
    if "--review" in sys.argv:
        from review_deliveries import review
        review(call)
        return
    changed = 0
    for _ in range(20):
        batch = call({"action": "backfill"})
        changed += batch["changed"]
        if batch["failed"]:
            print("Кнопки добавлены к %d заявкам; %d старых сообщений недоступны для редактирования." % (changed, batch["failed"]))
            break
        if not batch["remaining"]:
            print("Кнопки добавлены к существующим заявкам: %d." % changed)
            break
    print("Статусы подключены. Токен бота не считывался и не выводился.")


if __name__ == "__main__":
    main()

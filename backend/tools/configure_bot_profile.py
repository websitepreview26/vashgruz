#!/usr/bin/env python3
"""Publish and verify bot descriptions without reading or printing the bot token."""
import argparse
import json
import os
import secrets
import subprocess
import time

from connect_telegram import ROOT, connection, runtime


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--config")
    args = parser.parse_args(argv)
    target = connection(args.config)
    cli = runtime() + ["--config", str(target["path"])]
    env = {**os.environ, "CLOUDFLARE_ACCOUNT_ID": target["account"], "WRANGLER_SEND_METRICS": "false", "WRANGLER_LOG_PATH": os.devnull}
    for key in ("CLOUDFLARE_API_TOKEN", "CLOUDFLARE_API_KEY", "CLOUDFLARE_EMAIL"):
        env.pop(key, None)
    who = subprocess.run(cli + ["whoami", "--json"], cwd=ROOT, env=env, capture_output=True, text=True)
    try:
        identity = json.loads(who.stdout)
        if who.returncode or not identity.get("loggedIn") or not any(a["id"] == target["account"] for a in identity.get("accounts", [])):
            raise ValueError()
    except (ValueError, KeyError):
        raise SystemExit("Не удалось проверить нужный аккаунт Cloudflare. Описание не изменялось.")
    # Only the short-lived administration key is rotated. BOT_TOKEN and the active
    # Telegram webhook secret stay in Cloudflare and are never read by this helper.
    admin_key = secrets.token_urlsafe(40)
    saved = subprocess.run(cli + ["secret", "put", "ADMIN_SETUP_SECRET"], input=admin_key, cwd=ROOT, env=env, capture_output=True, text=True)
    if saved.returncode:
        raise SystemExit("Cloudflare не подтвердил административный ключ. Секреты не выводятся.")
    source = """
const fs=require('node:fs');const d=JSON.parse(fs.readFileSync(0,'utf8'));
fetch(d.url,{method:'POST',headers:{authorization:'Bearer '+d.key,'content-type':'application/json'},body:JSON.stringify({action:'bot_profile'}),signal:AbortSignal.timeout(90000)})
.then(async r=>{const body=await r.json();console.log(JSON.stringify(body));if(!r.ok)process.exitCode=1})
.catch(()=>{console.log(JSON.stringify({ok:false,message:'Не удалось проверить обновление описания.'}));process.exitCode=1});
"""
    for attempt in range(7):
        payload = json.dumps({"url": target["url"] + "/internal/telegram/setup", "key": admin_key})
        result = subprocess.run([cli[0], "-e", source], input=payload, capture_output=True, text=True, timeout=95)
        try:
            data = json.loads(result.stdout)
        except ValueError:
            raise SystemExit("Не получено подтверждение Worker. Токен бота не считывался.")
        if data.get("code") == "SETUP_AUTH" and attempt < 6:
            time.sleep(attempt + 1)
            continue
        if result.returncode or not data.get("ok") or not data.get("verified"):
            raise SystemExit(data.get("message", "Описание не подтверждено Telegram."))
        if data.get("bot", "").lower() != target["bot"].lower():
            raise SystemExit("Ответил другой бот. Проверьте конфигурацию.")
        print("Описание, краткая информация, команды и кнопка меню подтверждены Telegram для @" + data["bot"] + ".")
        print("Приветствие закрепится в личном чате при /start или первом обращении.")
        print("Очистка новых сообщений: " + ("включена" if data.get("cleanup") else "выключена") + ".")
        return
    raise SystemExit("Обновление административного ключа ещё не подтверждено.")


if __name__ == "__main__":
    main()

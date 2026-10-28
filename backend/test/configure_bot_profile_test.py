import contextlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

tools = Path(__file__).resolve().parents[1] / "tools"
sys.dont_write_bytecode = True
sys.path.insert(0, str(tools))
try:
    spec = importlib.util.spec_from_file_location("configure_bot_profile", tools / "configure_bot_profile.py")
    profile = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(profile)
finally:
    sys.path.pop(0)


class ProfileSetupTests(unittest.TestCase):
    def test_admin_key_is_only_sent_via_stdin_and_active_webhook_key_is_untouched(self):
        target = {"path": tools.parent / "wrangler.production.jsonc", "account": "expected-account", "bot": "vash_gruz_by_bot", "url": "https://production.example"}
        calls = []
        keys = []

        def run(args, **kwargs):
            calls.append(args)
            if "whoami" in args:
                data = {"loggedIn": True, "accounts": [{"id": target["account"]}]}
            elif "secret" in args:
                self.assertEqual(args[-2:], ["put", "ADMIN_SETUP_SECRET"])
                keys.append(kwargs["input"])
                data = {}
            else:
                payload = json.loads(kwargs["input"])
                self.assertEqual(payload["key"], keys[0])
                self.assertEqual(payload["url"], target["url"] + "/internal/telegram/setup")
                data = {"ok": True, "verified": True, "bot": target["bot"], "cleanup": True}
            return subprocess.CompletedProcess(args, 0, stdout=json.dumps(data), stderr="")

        output = io.StringIO()
        with patch.object(profile, "connection", return_value=target), patch.object(profile, "runtime", return_value=["node", "wrangler"]), patch.object(profile.subprocess, "run", side_effect=run), contextlib.redirect_stdout(output):
            profile.main(["--config", "wrangler.production.jsonc"])
        self.assertEqual(len(calls), 3)
        self.assertTrue(keys)
        self.assertNotIn(keys[0], output.getvalue())
        for command in calls:
            self.assertNotIn(keys[0], " ".join(command))
            self.assertNotIn("TELEGRAM_WEBHOOK_SECRET", command)
            self.assertNotIn("BOT_TOKEN", command)

    def test_wrong_account_does_not_change_any_secret(self):
        target = {"path": tools.parent / "wrangler.production.jsonc", "account": "expected-account"}
        result = subprocess.CompletedProcess([], 0, stdout='{"loggedIn":true,"accounts":[{"id":"other"}]}', stderr="")
        with patch.object(profile, "connection", return_value=target), patch.object(profile, "runtime", return_value=["node", "wrangler"]), patch.object(profile.subprocess, "run", return_value=result) as run:
            with self.assertRaises(SystemExit):
                profile.main([])
            self.assertEqual(run.call_count, 1)


if __name__ == "__main__":
    unittest.main()

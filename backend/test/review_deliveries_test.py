import contextlib
import importlib.util
import io
from pathlib import Path
import unittest
from unittest.mock import patch

source = Path(__file__).resolve().parents[1] / "tools/review_deliveries.py"
spec = importlib.util.spec_from_file_location("review_deliveries", source)
reviewer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reviewer)


class ReviewTests(unittest.TestCase):
    def test_empty_queue_does_not_request_confirmation(self):
        with patch("builtins.input") as prompt, contextlib.redirect_stdout(io.StringIO()):
            reviewer.review(lambda body: {"orders": [], "notifications": []})
            prompt.assert_not_called()

    def test_checked_absence_submits_version_note_and_exact_confirmation(self):
        calls = []
        order_id = "VG-123456789ABC"

        def call(body):
            calls.append(body)
            return {"orders": [{"id": order_id, "state": "uncertain", "delivery_attempts": 1, "updated_at": 123}], "notifications": []}

        with patch("builtins.input", side_effect=[order_id, "нет", "Проверена группа заказов", order_id]), contextlib.redirect_stdout(io.StringIO()):
            reviewer.review(call)
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[1]["action"], "resolve_order")
        self.assertEqual(calls[1]["outcome"], "not_delivered")
        self.assertEqual(calls[1]["expectedUpdatedAt"], 123)
        self.assertEqual(calls[1]["confirmation"], order_id)

    def test_mismatched_confirmation_does_not_resolve_anything(self):
        calls = []
        order_id = "VG-123456789ABC"

        def call(body):
            calls.append(body)
            return {"orders": [{"id": order_id, "state": "uncertain", "delivery_attempts": 1, "updated_at": 123}], "notifications": []}

        with patch("builtins.input", side_effect=[order_id, "да", "700", "Проверена карточка", "wrong"]), contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(SystemExit):
                reviewer.review(call)
        self.assertEqual(len(calls), 1)


if __name__ == "__main__":
    unittest.main()

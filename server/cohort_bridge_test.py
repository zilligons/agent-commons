import unittest
from cohort_bridge import describe_error

class FakeCode:
    def __init__(self, name):
        self.name = name

class FakeRpcError(Exception):
    def __init__(self, status, detail=""):
        self.status, self.detail = status, detail
    def code(self):
        return FakeCode(self.status)
    def details(self):
        return self.detail

class ErrorDiagnosticsTests(unittest.TestCase):
    def test_empty_response_runtime_error(self):
        result = describe_error(RuntimeError("Empty provider response fixture-only-private-detail"))
        self.assertEqual(result["code"], "EMPTY_RESPONSE")
        self.assertFalse(result["retryable"])
        self.assertNotIn("fixture-only-private-detail", str(result))

    def test_categories(self):
        expected = {
            "NOT_FOUND": "MODEL_UNAVAILABLE",
            "PERMISSION_DENIED": "ACCESS_DENIED",
            "UNAUTHENTICATED": "AUTHENTICATION",
            "RESOURCE_EXHAUSTED": "RATE_LIMIT",
            "DEADLINE_EXCEEDED": "TIMEOUT",
            "INVALID_ARGUMENT": "UNSUPPORTED_PARAMETERS",
            "UNAVAILABLE": "PROVIDER_UNAVAILABLE",
            "UNKNOWN": "TRANSPORT_ERROR",
        }
        for status, code in expected.items():
            with self.subTest(status=status):
                self.assertEqual(describe_error(FakeRpcError(status))["code"], code)

    def test_private_details_never_returned(self):
        secret = "Bearer private-value https://private.invalid/?token=private-value"
        result = describe_error(FakeRpcError("NOT_FOUND", secret))
        self.assertNotIn("private-value", str(result))
        self.assertNotIn("private.invalid", str(result))
        self.assertFalse(result["retryable"])

    def test_known_model_failure_from_unknown_status(self):
        result = describe_error(FakeRpcError("UNKNOWN", "unsupported model gpt_6_1_sol"))
        self.assertEqual(result["code"], "MODEL_UNAVAILABLE")

    def test_timeout_is_retryable(self):
        self.assertTrue(describe_error(TimeoutError())["retryable"])

    def test_unknown_status_and_debug_category_never_escape(self):
        class Info:
            error_type = "secret_value_1234567890"
        error = FakeRpcError("secret_value_1234567890")
        error.debug_info = [Info()]
        result = describe_error(error)
        self.assertIsNone(result["transportStatus"])
        self.assertNotIn("secret_value", str(result))

if __name__ == "__main__":
    unittest.main()

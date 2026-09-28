import re
import unittest

from backloop import REDACTED, redact, redact_string


class RedactStringTest(unittest.TestCase):
    def assertRedacts(self, text, expected):
        self.assertEqual(redact_string(text), expected)

    def test_bearer_tokens(self):
        self.assertRedacts("Authorization: Bearer abcdefghijkl", "Authorization: [REDACTED]")
        self.assertRedacts("bearer   abc.def-ghi~jkl+mno/pq==", REDACTED)
        self.assertRedacts("Bearer short", "Bearer short")

    def test_basic_auth_is_case_sensitive(self):
        self.assertRedacts("Basic dXNlcjpwYXNzd29yZA==", REDACTED)
        self.assertRedacts("basic dXNlcjpwYXNzd29yZA==", "basic dXNlcjpwYXNzd29yZA==")

    def test_jwt(self):
        jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"
        self.assertRedacts(f"token {jwt} end", "token [REDACTED] end")

    def test_vendor_keys(self):
        for secret in (
            "sk-ant-api03-abcdefghijklmnopqrstuv",
            "sk-proj-abcdefghijklmnop1234",
            "sk_live_abcdefghij12",
            "pk_test_1234567890",
            "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
            "github_pat_11ABCDEFG0123456789_abcdefghijklmnop",
            "xoxb-1234567890-abcdef",
            "AKIAIOSFODNN7EXAMPLE",
            "AIzaSyA-abcdefghijklmnopqrstuvwxyz01234",
        ):
            with self.subTest(secret=secret):
                self.assertRedacts(f"key: {secret}.", "key: [REDACTED].")

    def test_near_misses_are_kept(self):
        for text in ("sk-short", "rk_live_abc", "xAKIAIOSFODNN7EXAMPLE", "nothing to see here", ""):
            with self.subTest(text=text):
                self.assertRedacts(text, text)

    def test_private_key_block(self):
        pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nabc\n-----END RSA PRIVATE KEY-----"
        self.assertRedacts(f"key:\n{pem}\nafter", "key:\n[REDACTED]\nafter")

    def test_query_string_secrets_keep_the_parameter_name(self):
        self.assertRedacts(
            "GET https://api.example.com/v1?api_key=abc123&page=2",
            "GET https://api.example.com/v1?api_key=[REDACTED]&page=2",
        )
        self.assertRedacts("?APIKEY=zzz&token=yyy", "?APIKEY=[REDACTED]&token=[REDACTED]")
        self.assertRedacts('&access_token=abc"rest', '&access_token=[REDACTED]"rest')
        self.assertRedacts("?password=hunter2 next", "?password=[REDACTED] next")

    def test_card_numbers_are_luhn_checked(self):
        self.assertRedacts("card 4242 4242 4242 4242 ok", "card [REDACTED] ok")
        self.assertRedacts("4111-1111-1111-1111", REDACTED)
        self.assertRedacts("card 4242-4242-4242-4241 bad luhn", "card 4242-4242-4242-4241 bad luhn")
        self.assertRedacts("order 1234567890123", "order 1234567890123")
        self.assertRedacts("id 79927398713", "id 79927398713")  # Luhn-valid but too short

    def test_emails(self):
        self.assertRedacts("mail john.doe+tag@example.co.uk now", "mail [REDACTED] now")
        self.assertRedacts("not@mail", "not@mail")
        self.assertEqual(redact_string("mail a@b.co", emails=False), "mail a@b.co")

    def test_ascii_word_boundaries_like_js(self):
        self.assertRedacts("café sk-abcdefghijklmnopqrstuvwxyz", "café [REDACTED]")
        self.assertRedacts("Zürich é@x.com ü", "Zürich é@x.com ü")

    def test_unicode_whitespace_like_js(self):
        self.assertRedacts("BEARER abcdefghijklmn", REDACTED)
        self.assertRedacts("&signature=x　y", "&signature=[REDACTED]　y")

    def test_extra_patterns(self):
        self.assertEqual(redact_string("user 42 at acme", patterns=[r"acme"]), "user 42 at [REDACTED]")
        compiled = re.compile(r"(internal-id=)\w+")
        self.assertEqual(redact_string("x internal-id=abc y", patterns=[compiled]), "x internal-id=[REDACTED] y")


class RedactValueTest(unittest.TestCase):
    def test_sensitive_keys(self):
        value = {
            "Authorization": "Bearer x",
            "COOKIE": "a=b",
            "x-api-key": 5,
            "api_key": "k",
            "apikey": "k",
            "Access-Token": "t",
            "client_secret": "s",
            "card_number": 1,
            "CVV": "123",
            "tokens": "keep me",
            "set-cookie": None,
        }
        out = redact(value)
        for key in ("Authorization", "COOKIE", "x-api-key", "api_key", "apikey", "Access-Token", "client_secret",
                    "card_number", "CVV"):
            self.assertEqual(out[key], REDACTED, key)
        self.assertEqual(out["tokens"], "keep me")
        self.assertIsNone(out["set-cookie"])

    def test_recurses_and_keeps_non_strings(self):
        value = {"n": 1.5, "b": False, "none": None, "list": ["a@b.co", 1, True, {"secret": ["x"]}]}
        self.assertEqual(
            redact(value),
            {"n": 1.5, "b": False, "none": None, "list": [REDACTED, 1, True, {"secret": REDACTED}]},
        )

    def test_does_not_mutate_input(self):
        value = {"message": "Bearer abcdefghijkl", "nested": {"password": "x"}}
        redact(value)
        self.assertEqual(value, {"message": "Bearer abcdefghijkl", "nested": {"password": "x"}})

    def test_options_propagate(self):
        self.assertEqual(redact({"a": ["x@y.io"]}, emails=False), {"a": ["x@y.io"]})
        self.assertEqual(redact({"a": ["acme"]}, patterns=["acme"]), {"a": [REDACTED]})

    def test_scalars(self):
        self.assertEqual(redact("sk-abcdefghijklmnopqrstu"), REDACTED)
        self.assertEqual(redact(7), 7)
        self.assertIsNone(redact(None))


if __name__ == "__main__":
    unittest.main()

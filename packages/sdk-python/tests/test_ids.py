import re
import time
import unittest

from backloop import hash_account, new_id

ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
ID_RE = re.compile(r"^fb_[0-9A-HJKMNP-TV-Z]{26}$")


def decode_time(id_: str) -> int:
    ms = 0
    for ch in id_.split("_", 1)[1][:10]:
        ms = ms * 32 + ALPHABET.index(ch)
    return ms


class NewIdTest(unittest.TestCase):
    def test_format(self):
        self.assertRegex(new_id(), ID_RE)
        self.assertRegex(new_id("iss"), r"^iss_[0-9A-HJKMNP-TV-Z]{26}$")

    def test_unique(self):
        self.assertEqual(len({new_id() for _ in range(2000)}), 2000)

    def test_timestamp_prefix_is_current_time(self):
        before = time.time_ns() // 1_000_000
        id_ = new_id()
        after = time.time_ns() // 1_000_000
        self.assertTrue(before <= decode_time(id_) <= after)

    def test_sortable_by_time(self):
        ids = []
        for _ in range(5):
            ids.append(new_id())
            time.sleep(0.002)
        self.assertEqual(sorted(ids), ids)


class HashAccountTest(unittest.TestCase):
    def test_known_vector_matches_typescript_sdk(self):
        # Produced by hashAccount("acct_123", "s3cret") in @backloop/sdk.
        self.assertEqual(hash_account("acct_123", "s3cret"), "acct_f94bc6a46353bc91ecb4dfba")

    def test_lone_surrogates_encode_like_text_encoder(self):
        # Produced by hashAccount("é\uD800", "k") in @backloop/sdk.
        self.assertEqual(hash_account("é\ud800", "k"), "acct_729cc3ac73301b38ae3dab4d")

    def test_deterministic_and_keyed(self):
        self.assertEqual(hash_account("cus_1", "k"), hash_account("cus_1", "k"))
        self.assertNotEqual(hash_account("cus_1", "k"), hash_account("cus_1", "other"))
        self.assertNotEqual(hash_account("cus_1", "k"), hash_account("cus_2", "k"))
        self.assertRegex(hash_account("cus_1", "k"), r"^acct_[0-9a-f]{24}$")


if __name__ == "__main__":
    unittest.main()

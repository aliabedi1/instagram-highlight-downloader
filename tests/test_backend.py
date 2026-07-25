import unittest
from unittest.mock import Mock, patch

from local_backend import app as backend


class ProfileCacheTests(unittest.TestCase):
    def setUp(self) -> None:
        backend.scan_cache.clear()
        backend.rate_limit_until.clear()

    @patch.object(backend, "make_loader")
    @patch.object(backend.instaloader.Profile, "from_username")
    def test_reuses_profile_and_highlights_for_follow_up_actions(
        self,
        from_username: Mock,
        make_loader: Mock,
    ) -> None:
        loader = Mock()
        profile = Mock()
        highlights = [Mock(), Mock()]
        make_loader.return_value = loader
        from_username.return_value = profile
        loader.get_highlights.return_value = highlights

        first = backend.load_profile_and_highlights(
            "https://www.instagram.com/jannatkhah.ir/",
            "1liabedi",
        )
        second = backend.load_profile_and_highlights(
            "https://www.instagram.com/jannatkhah.ir/",
            "1liabedi",
        )

        self.assertIs(first[0], loader)
        self.assertIs(second[0], loader)
        self.assertEqual(second[2], highlights)
        make_loader.assert_called_once_with("1liabedi")
        from_username.assert_called_once_with(loader.context, "jannatkhah.ir")
        loader.get_highlights.assert_called_once_with(profile)


if __name__ == "__main__":
    unittest.main()

"""Tests for headless browser mode (HeadlessBrowser + headless param on decon/tune)."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from calab._bridge._headless import HeadlessBrowser, _check_playwright


# ---------------------------------------------------------------------------
# HeadlessBrowser unit tests (no Playwright required)
# ---------------------------------------------------------------------------


class TestCheckPlaywright:
    def test_missing_playwright_raises(self):
        with patch.dict("sys.modules", {"playwright": None}):
            with pytest.raises(ImportError, match="pip install calab\\[headless\\]"):
                _check_playwright()


class TestHeadlessBrowserInit:
    def test_raises_without_playwright(self):
        """HeadlessBrowser() raises ImportError when playwright is missing."""
        with patch(
            "calab._bridge._headless._check_playwright",
            side_effect=ImportError("no playwright"),
        ):
            with pytest.raises(ImportError, match="no playwright"):
                HeadlessBrowser()


class TestHeadlessBrowserLifecycle:
    def test_navigate_without_start_raises(self):
        with patch("calab._bridge._headless._check_playwright"):
            hb = HeadlessBrowser()
            with pytest.raises(RuntimeError, match="not started"):
                hb.navigate("http://example.com")

    def test_page_without_start_raises(self):
        with patch("calab._bridge._headless._check_playwright"):
            hb = HeadlessBrowser()
            with pytest.raises(RuntimeError, match="not started"):
                _ = hb.page

    def test_is_alive_before_start(self):
        with patch("calab._bridge._headless._check_playwright"):
            hb = HeadlessBrowser()
            assert hb.is_alive is False

    def test_close_without_start_is_safe(self):
        with patch("calab._bridge._headless._check_playwright"):
            hb = HeadlessBrowser()
            hb.close()  # Should not raise


class TestHeadlessBrowserMocked:
    """Test start/navigate/close with a fully mocked Playwright."""

    def _make_mocked_browser(self) -> HeadlessBrowser:
        """Create a HeadlessBrowser with mocked Playwright internals."""
        with patch("calab._bridge._headless._check_playwright"):
            hb = HeadlessBrowser()

        mock_pw = MagicMock()
        mock_browser = MagicMock()
        mock_context = MagicMock()
        mock_page = MagicMock()

        mock_pw.chromium.launch.return_value = mock_browser
        mock_browser.new_context.return_value = mock_context
        mock_browser.is_connected.return_value = True
        mock_context.new_page.return_value = mock_page

        with patch(
            "calab._bridge._headless.sync_playwright",
            create=True,
        ) as mock_sync:
            # Patch the import inside the start() method
            mock_entry = MagicMock()
            mock_entry.start.return_value = mock_pw
            mock_sync.return_value = mock_entry

            # Directly patch the import at function level
            import calab._bridge._headless as headless_mod
            original_start = headless_mod.HeadlessBrowser.start

            def patched_start(self):
                self._pw = mock_pw
                self._browser = mock_browser
                self._context = mock_context
                self._page = mock_page

            headless_mod.HeadlessBrowser.start = patched_start
            try:
                hb.start()
            finally:
                headless_mod.HeadlessBrowser.start = original_start

        hb._mock_pw = mock_pw
        hb._mock_browser = mock_browser
        hb._mock_context = mock_context
        hb._mock_page = mock_page
        return hb

    def test_start_creates_page(self):
        hb = self._make_mocked_browser()
        assert hb._page is not None
        assert hb.is_alive is True

    def test_navigate_calls_goto(self):
        hb = self._make_mocked_browser()
        hb.navigate("http://example.com/test")
        hb._mock_page.goto.assert_called_once_with(
            "http://example.com/test", wait_until="domcontentloaded",
        )

    def test_close_cleans_up(self):
        hb = self._make_mocked_browser()
        hb.close()
        hb._mock_context.close.assert_called_once()
        hb._mock_browser.close.assert_called_once()
        assert hb._page is None
        assert hb._browser is None
        assert hb._context is None

    def test_context_manager(self):
        with patch("calab._bridge._headless._check_playwright"):
            hb = HeadlessBrowser()

        mock_pw = MagicMock()
        mock_browser = MagicMock()
        mock_context = MagicMock()
        mock_page = MagicMock()
        mock_pw.chromium.launch.return_value = mock_browser
        mock_browser.new_context.return_value = mock_context
        mock_context.new_page.return_value = mock_page

        import calab._bridge._headless as headless_mod
        original_start = headless_mod.HeadlessBrowser.start

        def patched_start(self):
            self._pw = mock_pw
            self._browser = mock_browser
            self._context = mock_context
            self._page = mock_page

        headless_mod.HeadlessBrowser.start = patched_start
        try:
            with hb:
                assert hb._page is mock_page
            # After exit, should be cleaned up
            assert hb._page is None
        finally:
            headless_mod.HeadlessBrowser.start = original_start


# ---------------------------------------------------------------------------
# _resolve_headless tests
# ---------------------------------------------------------------------------


class TestResolveHeadless:
    def test_none_returns_none(self):
        from calab._bridge._apps import _resolve_headless
        browser, owns = _resolve_headless(None)
        assert browser is None
        assert owns is False

    def test_false_returns_none(self):
        from calab._bridge._apps import _resolve_headless
        browser, owns = _resolve_headless(False)
        assert browser is None
        assert owns is False

    def test_instance_passes_through(self):
        from calab._bridge._apps import _resolve_headless
        with patch("calab._bridge._headless._check_playwright"):
            hb = HeadlessBrowser()
        browser, owns = _resolve_headless(hb)
        assert browser is hb
        assert owns is False

    def test_true_creates_and_starts(self):
        from calab._bridge._apps import _resolve_headless
        with patch("calab._bridge._headless._check_playwright"):
            with patch.object(HeadlessBrowser, "start") as mock_start:
                browser, owns = _resolve_headless(True)
                assert isinstance(browser, HeadlessBrowser)
                assert owns is True
                mock_start.assert_called_once()

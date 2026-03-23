"""Tests for headless browser mode (HeadlessBrowser + headless param on decon/tune)."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import numpy as np
import pytest

from calab._bridge._headless import HeadlessBrowser, _check_playwright

try:
    from playwright.sync_api import sync_playwright as _  # noqa: F401

    HAS_PLAYWRIGHT = True
except ImportError:
    HAS_PLAYWRIGHT = False


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
# _managed_headless tests
# ---------------------------------------------------------------------------


class TestManagedHeadless:
    def test_none_yields_none(self):
        from calab._bridge._apps import _managed_headless
        with _managed_headless(None) as browser:
            assert browser is None

    def test_false_yields_none(self):
        from calab._bridge._apps import _managed_headless
        with _managed_headless(False) as browser:
            assert browser is None

    def test_instance_passes_through(self):
        from calab._bridge._apps import _managed_headless
        with patch("calab._bridge._headless._check_playwright"):
            hb = HeadlessBrowser()
        with _managed_headless(hb) as browser:
            assert browser is hb

    def test_true_creates_starts_and_closes(self):
        from calab._bridge._apps import _managed_headless
        with patch("calab._bridge._headless._check_playwright"):
            with patch.object(HeadlessBrowser, "start") as mock_start:
                with patch.object(HeadlessBrowser, "close") as mock_close:
                    with _managed_headless(True) as browser:
                        assert isinstance(browser, HeadlessBrowser)
                        mock_start.assert_called_once()
                    mock_close.assert_called_once()


# ---------------------------------------------------------------------------
# Integration tests (require Playwright + Chromium + network access)
# ---------------------------------------------------------------------------

_skip_no_playwright = pytest.mark.skipif(
    not HAS_PLAYWRIGHT, reason="playwright not installed",
)


@_skip_no_playwright
@pytest.mark.integration
class TestHeadlessDeconIntegration:
    """End-to-end tests that launch a real headless browser against the
    hosted CaDecon page.  These verify that the HTTPS→localhost bridge
    actually works (the Private Network Access issue that prompted this).
    """

    def test_decon_headless_true(self):
        """decon(headless=True) returns a valid CaDeconResult."""
        import calab

        traces = np.random.randn(3, 200)
        result = calab.decon(
            traces,
            30.0,
            headless=True,
            autorun=True,
            timeout=60,
            max_iterations=5,
        )
        assert result is not None
        assert result.activity.shape == (3, 200)
        assert result.activity.dtype == np.float32
        assert len(result.alphas) == 3
        assert len(result.baselines) == 3
        assert len(result.pves) == 3
        assert result.kernel_slow.shape[0] > 0
        assert result.fs == 30.0

    def test_decon_headless_browser_reuse(self):
        """A single HeadlessBrowser instance works across two decon() calls."""
        import calab

        with HeadlessBrowser() as hb:
            r1 = calab.decon(
                np.random.randn(2, 150),
                30.0,
                headless=hb,
                autorun=True,
                timeout=60,
                max_iterations=5,
            )
            assert r1 is not None
            assert r1.activity.shape == (2, 150)

            r2 = calab.decon(
                np.random.randn(4, 100),
                30.0,
                headless=hb,
                autorun=True,
                timeout=60,
                max_iterations=5,
            )
            assert r2 is not None
            assert r2.activity.shape == (4, 100)

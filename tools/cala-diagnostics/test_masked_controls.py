"""Protocol checks; optional scientific dependencies skip cleanly."""
import importlib.util
from pathlib import Path
import tempfile
import unittest

AVAILABLE=all(importlib.util.find_spec(name) is not None for name in ('numpy','scipy','matplotlib'))
if AVAILABLE:
    import numpy as np
    from types import SimpleNamespace
    from unittest.mock import patch
    import masked_controls as harness

@unittest.skipUnless(AVAILABLE,'numpy/scipy/matplotlib are optional experiment dependencies')
class ControlsProtocolTests(unittest.TestCase):
    def test_evaluator_offset_is_inverted_and_negative_lobes_preserved(self):
        # Evaluator working+(2,-1)=GT; invert that shift before local crop.
        pixels=np.array([3*8+3,4*8+4],dtype=np.uint32)
        fp=(pixels,np.array([2.,-1.]),np.array([2.,-1.]))
        meta=dict(width='8',rect_y0='0',rect_x0='0',rect_height='6',rect_width='6')
        snapshot=SimpleNamespace(meta=meta,inv_sigma=np.ones(36),b=np.zeros((36,9)))
        # The real crop/whitening path runs; only the footprint file reader is replaced.
        with patch.object(harness.controls,'read_fp',return_value=((8,8),{7:fp})):
            gt,norm=harness.ground_truth(dict(gt_footprints='unused',gt_id=7,gt_offset=[2,-1]),snapshot)
        expected=np.zeros((6,6));expected[1,4]=2.;expected[2,5]=-1.
        np.testing.assert_array_equal(gt.reshape(6,6),expected)
        self.assertAlmostEqual(norm,np.linalg.norm(gt))
        # Roundtrip coordinates land back on the original full-frame GT pixels.
        yy,xx=np.nonzero(gt.reshape(6,6))
        np.testing.assert_array_equal((yy+2)*8+(xx-1),pixels)

    def test_external_calibration_rejects_mixed_splits_before_io(self):
        with self.assertRaisesRegex(ValueError,'evaluation-only'):
            harness.external_calibration(Path('/nonexistent'),{},[dict(label='x',splits=['calibration','evaluation'])])

    def test_external_calibration_rejects_changed_solver_source(self):
        import json
        keys=('seeds','models','noise_quantum_whitened','negative_families','positive_snr',
              'amplitudes','masked_score','baseline_score','gt_alignment',
              'solver_source_sha256','background_models_source_sha256','controls_source_sha256')
        config={key:'same' for key in keys}
        previous=config|{'solver_source_sha256':'different'}
        with tempfile.TemporaryDirectory() as d:
            (Path(d)/'config.json').write_text(json.dumps(previous))
            with self.assertRaisesRegex(ValueError,'solver_source_sha256'):
                harness.external_calibration(Path(d),config,[dict(label='new',splits=['evaluation'])])

if __name__=='__main__':unittest.main()

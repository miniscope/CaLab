"""Small synthetic regressions for diagnostic accounting; no recordings needed."""
import csv
import json
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest

import profile_run


class DiagnosticTests(unittest.TestCase):
    def test_working_id_without_publication_stays_unpublished(self):
        with tempfile.TemporaryDirectory() as directory:
            run = Path(directory)
            column = struct.pack('<Iff', 9, 1.0, 1.0)
            (run / 'footprints.bin').write_bytes(
                b'CALAFP01' + struct.pack('<III', 8, 8, 1)
                + struct.pack('<II', 1, 1) + column
            )
            (run / 'footprint_history.bin').write_bytes(
                b'CALAFPH1' + struct.pack('<II', 8, 8)
                + struct.pack('<QQQI', 1, 1, 1, 1) + column
            )
            (run / 'library_versions.tsv').write_text(
                'observed_frames\tversion\tcells\tids\n1\t1\t1\t1\n3\t2\t1\t1\n'
            )
            (run / 'edits.tsv').write_text(
                'frame\tkind\tid\tother\tcy\tcx\tmargin\trecording_frame\n'
                '1\tadd\t1\t0\t1\t1\t5\t0\n'
                '2\tadd\t2\t0\t2\t2\t5\t1\n'
                '3\tdelete\t2\t0\t2\t2\t0\t2\n'
            )
            subprocess.run(
                [sys.executable, str(Path(__file__).with_name('analyze_evolution.py')),
                 str(run), '--start', '0', '--all-cases'],
                check=True, capture_output=True, text=True,
            )
            summary = json.loads((run / 'analysis/analysis_summary.json').read_text())
            self.assertEqual(summary['unique_ids'], 2)
            self.assertEqual(summary['published_unique_ids'], 1)
            self.assertEqual(summary['unpublished_ids'], 1)
            self.assertTrue(all(summary['validation'].values()))
            with (run / 'analysis/all_ids.tsv').open() as stream:
                ids = {int(row['id']): row for row in csv.DictReader(stream, delimiter='\t')}
            self.assertEqual(ids[2]['shape_snapshots'], '0')
            self.assertEqual(ids[2]['end_reason'], 'delete')

    def test_profile_ignores_partial_trailing_numeric_field(self):
        with tempfile.TemporaryDirectory() as directory:
            run = Path(directory)
            keys = ['frame', *profile_run.CORE, *profile_run.DIAGNOSTICS, 'work_add']
            header = '\t'.join(keys) + '\n'
            complete = '\t'.join(['0', *['1'] * (len(keys) - 1)]) + '\n'
            partial = '\t'.join(['1', *['1'] * (len(keys) - 2), '123'])
            (run / 'timings.tsv').write_text(header + complete + partial)
            report = profile_run.summarize(run, 20)
            self.assertEqual(report['frames'], 1)
            self.assertEqual(report['work_proxy']['work_add']['operations'], 1)
            self.assertEqual(report['core_per_frame']['mean_ms'], len(profile_run.CORE))


if __name__ == '__main__':
    unittest.main()

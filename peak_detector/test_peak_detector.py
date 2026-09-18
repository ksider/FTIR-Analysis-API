import math
import unittest

from peak_detector import detect_spectrum, robust_x_step


class PeakDetectorTests(unittest.TestCase):
    def test_uses_median_step_for_uneven_grid(self):
        self.assertEqual(robust_x_step([0, 2, 4, 6, 20]), 2)

    def test_keeps_broad_band_and_marks_co2_candidate(self):
        x_values = list(range(4000, 399, -2))
        points = []
        for x_value in x_values:
            baseline = 0.2 + 0.00008 * (4000 - x_value)
            broad = 0.75 * math.exp(-((x_value - 3340) / 180) ** 2)
            narrow = 0.55 * math.exp(-((x_value - 1715) / 18) ** 2)
            co2 = 0.2 * math.exp(-((x_value - 2350) / 10) ** 2)
            points.append([x_value, baseline + broad + narrow + co2])

        peaks, warnings, processing = detect_spectrum(
            {
                "id": "synthetic",
                "signalType": "absorbance",
                "points": points,
            },
            {
                "baselineMethod": "arpls",
                "smoothingWindow": 5,
                "minProminence": 0.02,
                "minSeparationCm1": 8,
                "broadProminenceWindowCm1": 800,
                "broadSmoothingWindow": 31,
                "broadMinSeparationCm1": 180,
                "crossEngineMergeCm1": 20,
                "maxPeaks": 50,
            },
        )

        self.assertFalse(warnings)
        self.assertEqual(processing["baselineMethod"], "arpls")
        self.assertTrue(any(abs(peak["nu"] - 3340) <= 4 and peak["shape"] == "broad" for peak in peaks))
        self.assertTrue(any(abs(peak["nu"] - 1715) <= 4 for peak in peaks))
        self.assertTrue(any("possible_atmospheric_co2" in peak["qualityFlags"] for peak in peaks))

    def test_limits_candidates_to_requested_search_range(self):
        x_values = list(range(4000, 399, -2))
        points = []
        for x_value in x_values:
            broad = 0.8 * math.exp(-((x_value - 3340) / 35) ** 2)
            narrow = 0.9 * math.exp(-((x_value - 1715) / 18) ** 2)
            points.append([x_value, broad + narrow])

        peaks, warnings, processing = detect_spectrum(
            {
                "id": "range-limited",
                "signalType": "absorbance",
                "points": points,
            },
            {
                "baselineMethod": "none",
                "smoothingWindow": 5,
                "minProminence": 0.02,
                "minSeparationCm1": 8,
                "searchRangeCm1": {"min": 3000, "max": 3600},
            },
        )

        self.assertFalse(warnings)
        self.assertEqual(processing["searchRangeCm1"], {"min": 3000.0, "max": 3600.0})
        self.assertTrue(peaks)
        self.assertTrue(all(3000 <= peak["nu"] <= 3600 for peak in peaks))
        self.assertFalse(any(abs(peak["nu"] - 1715) <= 5 for peak in peaks))

    def test_measures_manual_position_below_automatic_prominence_threshold(self):
        x_values = list(range(3700, 2999, -2))
        points = []
        for x_value in x_values:
            broad = 0.35 * math.exp(-((x_value - 3340) / 70) ** 2)
            points.append([x_value, broad])

        peaks, warnings, processing = detect_spectrum(
            {"id": "manual", "signalType": "absorbance", "points": points},
            {
                "baselineMethod": "none",
                "smoothingWindow": 5,
                "minProminence": 1.0,
                "manualPositionsBySpectrum": {"manual": [3330]},
                "manualSnapCm1": 18,
            },
        )

        self.assertFalse(peaks)
        self.assertFalse(warnings)
        measured = processing["manualMeasurements"]
        self.assertEqual(len(measured), 1)
        self.assertAlmostEqual(measured[0]["nu"], 3340, delta=4)
        self.assertIsNotNone(measured[0]["fwhmCm1"])
        self.assertEqual(measured[0]["shape"], "broad")


if __name__ == "__main__":
    unittest.main()

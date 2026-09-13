#!/usr/bin/env python3
"""Detect FTIR peaks independently for every spectrum.

Input and output are JSON over stdin/stdout. SciPy is used when available;
the small stdlib implementation keeps local development usable before SciPy
is installed.
"""

import json
import math
import sys


try:
    from scipy.signal import find_peaks as scipy_find_peaks
    from scipy.signal import peak_widths as scipy_peak_widths
except ImportError:  # pragma: no cover - exercised on minimal installations
    scipy_find_peaks = None
    scipy_peak_widths = None

try:
    from pybaselines import Baseline as PyBaseline
except ImportError:  # pragma: no cover - local fallback when optional dependency is absent
    PyBaseline = None


def finite(value):
    return isinstance(value, (int, float)) and math.isfinite(value)


def moving_average(values, window):
    if window <= 1 or len(values) < 3:
        return list(values)
    half = window // 2
    result = []
    for index in range(len(values)):
        lo = max(0, index - half)
        hi = min(len(values), index + half + 1)
        result.append(sum(values[lo:hi]) / (hi - lo))
    return result


def linear_baseline(x_values, values):
    if len(values) < 2:
        return [0.0] * len(values)
    x0, x1 = x_values[0], x_values[-1]
    y0, y1 = values[0], values[-1]
    span = x1 - x0
    if not span:
        return [y0] * len(values)
    return [y0 + (y1 - y0) * ((x - x0) / span) for x in x_values]


def estimate_baseline(x_values, values, settings):
    """Estimate a smooth background and keep a safe local fallback."""
    method = str(settings.get("baselineMethod", "arpls") or "arpls").lower()
    if method == "none":
        return [0.0] * len(values), "none", "none", None
    if method == "linear":
        return linear_baseline(x_values, values), "linear", "builtin", None
    if PyBaseline is None:
        return linear_baseline(x_values, values), "linear", "builtin-fallback", "pybaselines is not installed"

    try:
        fitter = PyBaseline(x_data=x_values, check_finite=True, assume_sorted=True)
        lam = min(1e12, max(1.0, float(settings.get("baselineLambda", 1e6) or 1e6)))
        asymmetry = min(0.5, max(1e-5, float(settings.get("baselineAsymmetry", 0.01) or 0.01)))
        if method == "arpls":
            baseline, _ = fitter.arpls(values, lam=lam)
        elif method == "airpls":
            baseline, _ = fitter.airpls(values, lam=lam)
        elif method == "asls":
            baseline, _ = fitter.asls(values, lam=lam, p=asymmetry)
        elif method == "snip":
            x_step = min(
                (abs(x_values[index + 1] - x_values[index]) for index in range(len(x_values) - 1) if x_values[index + 1] != x_values[index]),
                default=1.0,
            )
            half_window = max(1, int(round(float(settings.get("baselineSnipWindowCm1", 80) or 80) / x_step)))
            baseline, _ = fitter.snip(values, max_half_window=half_window)
        elif method == "rubberband":
            baseline, _ = fitter.rubberband(values)
        else:
            return linear_baseline(x_values, values), "linear", "builtin-fallback", "unknown baseline method: %s" % method
        return [float(value) for value in baseline], method, "pybaselines", None
    except Exception as error:  # pragma: no cover - depends on input and library version
        return linear_baseline(x_values, values), "linear", "builtin-fallback", "%s failed: %s" % (method, error)


def infer_signal_type(y_values, requested):
    """Infer the common FTIR export format when the client sends Auto.

    Most files opened by the web app are percent-transmittance exports.  They
    used to arrive as ``unknown`` and were therefore analysed as if their
    transmittance valleys were intensity maxima.  Keep explicit user choices
    authoritative and only infer the unambiguous percent-transmittance case.
    """
    requested = str(requested or "unknown").lower()
    if requested != "unknown":
        return requested
    if not y_values:
        return "unknown"
    minimum = min(y_values)
    maximum = max(y_values)
    span = maximum - minimum
    if minimum >= -1e-6 and maximum <= 110.0 and (maximum > 20.0 or span > 5.0):
        return "transmittance"
    return "unknown"


def fallback_find_peaks(values, min_distance, min_prominence, prominence_window=None):
    candidates = []
    window = max(3, prominence_window or min_distance * 2)
    for index in range(1, len(values) - 1):
        if values[index] <= values[index - 1] or values[index] < values[index + 1]:
            continue
        lo = max(0, index - window)
        hi = min(len(values), index + window + 1)
        prominence = values[index] - min(values[lo:hi])
        if prominence >= min_prominence:
            candidates.append((index, prominence))
    candidates.sort(key=lambda item: item[1], reverse=True)
    selected = []
    for index, prominence in candidates:
        if all(abs(index - other) >= min_distance for other in selected):
            selected.append(index)
    selected.sort()
    return selected, [values[index] - min(values[max(0, index - window):min(len(values), index + window + 1)]) for index in selected]


def merge_peak_candidates(primary_indices, primary_prominences, broad_indices, broad_prominences, min_distance, cross_engine_distance):
    """Merge duplicate maxima reported by the fine and broad passes.

    The two passes work on different signals, so the same physical band can
    be reported at adjacent samples.  Preserve the stronger candidate and
    use a slightly wider distance only when candidates came from different
    passes.  This avoids changing the user's fine peak separation setting for
    genuinely distinct peaks found by the same pass.
    """
    candidates = [
        (int(index), float(prominence), "primary")
        for index, prominence in zip(primary_indices, primary_prominences)
    ] + [
        (int(index), float(prominence), "broad")
        for index, prominence in zip(broad_indices, broad_prominences)
    ]
    candidates.sort(key=lambda item: item[1], reverse=True)
    selected = []
    for index, prominence, source in candidates:
        duplicate = False
        for other_index, _, other_source in selected:
            distance = cross_engine_distance if source != other_source else min_distance
            if abs(index - other_index) < distance:
                duplicate = True
                break
        if not duplicate:
            selected.append((index, prominence, source))
    selected.sort(key=lambda item: item[0])
    return [item[0] for item in selected], [item[1] for item in selected]


def local_fwhm(x_values, values, index, baseline_value):
    peak_height = values[index] - baseline_value
    if peak_height <= 0:
        return None
    half_level = baseline_value + peak_height / 2.0
    left = index
    right = index
    while left > 0 and values[left] > half_level:
        left -= 1
    while right < len(values) - 1 and values[right] > half_level:
        right += 1
    width = abs(x_values[right] - x_values[left])
    return width if width > 0 else None


def detect_spectrum(spectrum, settings):
    points = []
    for item in spectrum.get("points", []):
        if isinstance(item, list) and len(item) == 2 and finite(item[0]) and finite(item[1]):
            points.append((float(item[0]), float(item[1])))
    points.sort(key=lambda point: point[0])
    if len(points) < 5:
        return [], ["%s: fewer than 5 valid points" % spectrum.get("id", "spectrum")], {
            "baselineMethod": "none",
            "baselineEngine": "none",
            "signalType": "unknown",
            "displayYUnit": "unknown",
            "diagnostics": {"x": [], "signal": [], "baseline": [], "corrected": [], "broadCorrected": []},
        }

    x_values = [point[0] for point in points]
    y_values = [point[1] for point in points]
    signal_type = spectrum.get("signalType", "unknown")
    if signal_type == "unknown":
        signal_type = settings.get("signalType", "unknown")
    signal_type = infer_signal_type(y_values, signal_type)

    if signal_type == "transmittance":
        maximum = max(y_values)
        transmittance = [value * 100.0 if maximum <= 2.0 else value for value in y_values]
        signal = [math.log10(100.0 / max(value, 1e-9)) for value in transmittance]
    else:
        signal = list(y_values)

    smoothing_window = int(settings.get("smoothingWindow", 5) or 1)
    if smoothing_window % 2 == 0:
        smoothing_window += 1
    smoothing_window = max(1, min(101, smoothing_window))
    smoothed = moving_average(signal, smoothing_window)
    baseline, baseline_method, baseline_engine, baseline_warning = estimate_baseline(x_values, smoothed, settings)
    corrected = [value - base for value, base in zip(smoothed, baseline)]

    x_step = min((abs(x_values[index + 1] - x_values[index]) for index in range(len(x_values) - 1) if x_values[index + 1] != x_values[index]), default=1.0)
    min_separation = float(settings.get("minSeparationCm1", 8.0) or 8.0)
    min_distance_samples = max(1, int(round(min_separation / x_step)))
    min_prominence = float(settings.get("minProminence", 0.02) or 0.0)
    max_peaks = int(settings.get("maxPeaks", 200) or 200)
    broad_window_cm1 = max(50.0, float(settings.get("broadProminenceWindowCm1", 800) or 800))
    broad_window_samples = max(min_distance_samples * 8, int(round(broad_window_cm1 / x_step)))
    broad_smoothing_window = int(settings.get("broadSmoothingWindow", 31) or 31)
    if broad_smoothing_window % 2 == 0:
        broad_smoothing_window += 1
    broad_smoothing_window = max(3, min(101, broad_smoothing_window))
    broad_distance_samples = max(
        min_distance_samples,
        int(round(float(settings.get("broadMinSeparationCm1", 180) or 180) / x_step)),
    )
    cross_engine_distance_samples = max(
        min_distance_samples,
        int(round(float(settings.get("crossEngineMergeCm1", 20) or 20) / x_step)),
    )
    broad_smoothed = moving_average(signal, broad_smoothing_window)
    # The adaptive baseline used by the fine pass can correctly treat a very
    # broad OH/NH band as background.  The broad pass must retain that shape,
    # so use only a simple endpoint trend here.  This pass is intentionally a
    # band-preservation pass, not a second copy of the fine baseline fit.
    broad_baseline = (
        [0.0] * len(broad_smoothed)
        if str(settings.get("broadBaselineMethod", "linear") or "linear").lower() == "none"
        else linear_baseline(x_values, broad_smoothed)
    )
    broad_baseline_warning = None
    broad_corrected = [value - base for value, base in zip(broad_smoothed, broad_baseline)]

    properties = {}
    if scipy_find_peaks is not None:
        peak_indices, properties = scipy_find_peaks(
            corrected,
            distance=min_distance_samples,
            prominence=min_prominence,
            wlen=min(len(corrected), max(3, min_distance_samples * 8)),
        )
        broad_indices, broad_properties = scipy_find_peaks(
            broad_corrected,
            distance=broad_distance_samples,
            prominence=min_prominence,
            wlen=min(len(corrected), max(3, broad_window_samples)),
        )
        peak_indices, prominences = merge_peak_candidates(
            peak_indices,
            properties.get("prominences", []),
            broad_indices,
            broad_properties.get("prominences", []),
            min_distance_samples,
            cross_engine_distance_samples,
        )
    else:
        primary_indices, primary_prominences = fallback_find_peaks(corrected, min_distance_samples, min_prominence, min_distance_samples * 2)
        broad_indices, broad_prominences = fallback_find_peaks(broad_corrected, broad_distance_samples, min_prominence, broad_window_samples)
        peak_indices, prominences = merge_peak_candidates(
            primary_indices,
            primary_prominences,
            broad_indices,
            broad_prominences,
            min_distance_samples,
            cross_engine_distance_samples,
        )

    ranked = sorted(zip(peak_indices, prominences), key=lambda item: item[1], reverse=True)[:max_peaks]
    ranked.sort(key=lambda item: x_values[item[0]], reverse=True)
    max_prominence = max((float(item[1]) for item in ranked), default=1.0)
    results = []

    widths = {}
    if scipy_peak_widths is not None and peak_indices:
        try:
            width_values = scipy_peak_widths(corrected, peak_indices, rel_height=0.5)[0]
            widths = {index: float(width_values[position]) * x_step for position, index in enumerate(peak_indices)}
        except Exception:
            widths = {}

    for index, prominence in ranked:
        width = widths.get(index) or local_fwhm(x_values, corrected, index, 0.0)
        nu = x_values[index]
        if width is None:
            shape = "unknown"
        elif width <= 20:
            shape = "sharp"
        elif width >= 80:
            shape = "broad"
        else:
            shape = "band"
        lo = max(0, index - max(4, min_distance_samples * 2))
        hi = min(len(points), index + max(4, min_distance_samples * 2) + 1)
        local_window = [[x_values[item], y_values[item]] for item in range(lo, hi)]
        results.append({
            "id": "peak-%s-%s" % (spectrum["id"], str(round(nu, 2)).replace(".", "_")),
            "spectrumId": spectrum["id"],
            "nu": round(nu, 4),
            "originalNu": round(nu, 4),
            "height": round(corrected[index], 6),
            "prominence": round(float(prominence), 6),
            "widthCm1": round(float(width), 4) if width is not None else None,
            "fwhmCm1": round(float(width), 4) if width is not None else None,
            "shape": shape,
            "direction": "absorption",
            "detectionMethod": "automatic",
            "confidence": round(min(1.0, max(0.0, float(prominence) / max_prominence)), 4),
            "localWindow": local_window,
        })
    warnings = []
    if baseline_warning:
        warnings.append("%s: %s" % (spectrum.get("id", "spectrum"), baseline_warning))
    if broad_baseline_warning and broad_baseline_warning != baseline_warning:
        warnings.append("%s broad pass: %s" % (spectrum.get("id", "spectrum"), broad_baseline_warning))
    diagnostic_stride = max(1, int(math.ceil(len(points) / 1200)))
    diagnostics = {
        "x": [round(x_values[index], 6) for index in range(0, len(points), diagnostic_stride)],
        "signal": [round(signal[index], 8) for index in range(0, len(points), diagnostic_stride)],
        "baseline": [round(baseline[index], 8) for index in range(0, len(points), diagnostic_stride)],
        "corrected": [round(corrected[index], 8) for index in range(0, len(points), diagnostic_stride)],
        "broadCorrected": [round(broad_corrected[index], 8) for index in range(0, len(points), diagnostic_stride)],
    }
    if signal_type == "transmittance":
        # Keep the main chart in the user's original %T scale while peak
        # search continues in absorbance space.
        display_corrected = [100.0 * math.pow(10.0, min(6.0, max(-6.0, -value))) for value in corrected]
        display_y_unit = "%T"
    else:
        display_corrected = corrected
        display_y_unit = signal_type
    diagnostics["displayCorrected"] = [round(display_corrected[index], 8) for index in range(0, len(points), diagnostic_stride)]
    return results, warnings, {
        "baselineMethod": baseline_method,
        "baselineEngine": baseline_engine,
        "signalType": signal_type,
        "displayYUnit": display_y_unit,
        "diagnostics": diagnostics,
    }


def main():
    try:
        payload = json.load(sys.stdin)
        if payload.get("schemaVersion") != "2.0":
            raise ValueError("Unsupported schemaVersion")
        settings = payload.get("settings") or {}
        observations = []
        warnings = []
        processing = []
        for spectrum in payload.get("spectra", []):
            peaks, spectrum_warnings, spectrum_processing = detect_spectrum(spectrum, settings)
            observations.extend(peaks)
            warnings.extend(spectrum_warnings)
            processing.append({"spectrumId": spectrum.get("id"), **spectrum_processing})
        json.dump({
            "schemaVersion": "2.0",
            "peakObservations": observations,
            "settings": settings,
            "warnings": warnings,
            "engine": "scipy.signal.find_peaks" if scipy_find_peaks is not None else "stdlib-fallback",
            "processing": processing,
        }, sys.stdout)
    except Exception as error:
        json.dump({"error": str(error)}, sys.stdout)
        sys.exit(1)


if __name__ == "__main__":
    main()

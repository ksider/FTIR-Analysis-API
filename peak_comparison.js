const finiteNumber = (value) => (
  value === null || value === undefined || value === ''
    ? null
    : Number.isFinite(Number(value)) ? Number(value) : null
);

function normalizeObservation(observation, index = 0) {
  if (!observation || typeof observation !== 'object') return null;
  const nu = finiteNumber(observation.nu ?? observation.x);
  const spectrumId = observation.spectrumId ? String(observation.spectrumId) : '';
  if (nu === null || !spectrumId) return null;
  return {
    ...observation,
    id: String(observation.id || `peak-${spectrumId}-${index + 1}`),
    spectrumId,
    nu,
    prominence: finiteNumber(observation.prominence),
    height: finiteNumber(observation.height),
    widthCm1: finiteNumber(observation.widthCm1),
    fwhmCm1: finiteNumber(observation.fwhmCm1),
    confidence: finiteNumber(observation.confidence),
  };
}

function groupPeaks(observations, toleranceCm1 = 8) {
  const tolerance = Math.max(0.1, Number(toleranceCm1) || 8);
  const normalized = observations.map(normalizeObservation).filter(Boolean).sort((a, b) => b.nu - a.nu);
  const groups = [];

  normalized.forEach((observation) => {
    const matching = groups
      .filter((group) => !group.members.some((member) => member.spectrumId === observation.spectrumId))
      .map((group) => ({ group, distance: Math.abs(group.centerNu - observation.nu) }))
      .filter((candidate) => candidate.distance <= tolerance)
      .sort((a, b) => a.distance - b.distance);
    const target = matching[0]?.group || { centerNu: observation.nu, members: [] };
    if (!target.members.length) groups.push(target);
    target.members.push(observation);
    target.centerNu = target.members.reduce((sum, member) => sum + member.nu, 0) / target.members.length;
  });

  return groups
    .sort((a, b) => b.centerNu - a.centerNu)
    .map((group, index) => ({
      id: `group-${String(Math.round(group.centerNu)).replace('-', 'm')}-${index + 1}`,
      centerNu: Number(group.centerNu.toFixed(4)),
      toleranceCm1: tolerance,
      members: group.members.map((member) => ({
        spectrumId: member.spectrumId,
        peakId: member.id,
      })),
      observations: group.members,
    }));
}

function buildComparisonMatrix(spectra, observations, settings = {}) {
  const toleranceCm1 = Math.max(0.1, Number(settings.toleranceCm1) || 8);
  const shiftThresholdCm1 = Math.max(0.1, Number(settings.shiftThresholdCm1) || 2);
  const spectrumIds = (spectra || []).map((spectrum) => String(spectrum.id)).filter(Boolean);
  const normalized = observations.map(normalizeObservation).filter(Boolean);
  const groups = groupPeaks(normalized, toleranceCm1);
  const changes = [];
  const baselineSpectrumId = spectrumIds[0] || normalized[0]?.spectrumId || null;

  groups.forEach((group) => {
    const bySpectrum = new Map(group.observations.map((observation) => [observation.spectrumId, observation]));
    spectrumIds.forEach((spectrumId) => {
      if (!bySpectrum.has(spectrumId)) {
        group.observations.push(null);
      }
    });
    if (!baselineSpectrumId) return;
    const baseline = bySpectrum.get(baselineSpectrumId) || null;
    spectrumIds.slice(1).forEach((spectrumId) => {
      const current = bySpectrum.get(spectrumId) || null;
      if (baseline && !current) {
        changes.push({ type: 'disappeared_peak', groupId: group.id, fromSpectrumId: baselineSpectrumId, toSpectrumId: spectrumId, nu: baseline.nu });
      } else if (!baseline && current) {
        changes.push({ type: 'appeared_peak', groupId: group.id, fromSpectrumId: baselineSpectrumId, toSpectrumId: spectrumId, nu: current.nu });
      } else if (baseline && current) {
        const deltaNu = Number((current.nu - baseline.nu).toFixed(4));
        const deltaProminence = baseline.prominence !== null && current.prominence !== null
          ? Number((current.prominence - baseline.prominence).toFixed(4))
          : null;
        const deltaFwhm = baseline.fwhmCm1 !== null && current.fwhmCm1 !== null
          ? Number((current.fwhmCm1 - baseline.fwhmCm1).toFixed(4))
          : null;
        if (Math.abs(deltaNu) >= shiftThresholdCm1) {
          changes.push({ type: 'shifted_peak', groupId: group.id, fromSpectrumId: baselineSpectrumId, toSpectrumId: spectrumId, fromNu: baseline.nu, toNu: current.nu, deltaNu });
        }
        if (deltaProminence !== null && deltaProminence !== 0) {
          changes.push({ type: 'prominence_change', groupId: group.id, fromSpectrumId: baselineSpectrumId, toSpectrumId: spectrumId, deltaProminence });
        }
        if (deltaFwhm !== null && deltaFwhm !== 0) {
          changes.push({ type: 'width_change', groupId: group.id, fromSpectrumId: baselineSpectrumId, toSpectrumId: spectrumId, deltaFwhm });
        }
      }
    });
  });

  return {
    baselineSpectrumId,
    spectrumIds,
    toleranceCm1,
    shiftThresholdCm1,
    groups: groups.map(({ observations: _observations, ...group }) => group),
    changes,
  };
}

module.exports = { buildComparisonMatrix, groupPeaks, normalizeObservation };

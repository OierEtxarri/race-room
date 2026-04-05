import { useEffect } from 'react';
import { CircleMarker, MapContainer, Pane, Polyline, TileLayer, Tooltip, useMap } from 'react-leaflet';
import { latLngBounds, type LatLngTuple } from 'leaflet';
import type { ActivityRoute } from '../types';

const SATELLITE_URL =
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const HILLSHADE_URL =
  'https://services.arcgisonline.com/arcgis/rest/services/Elevation/World_Hillshade/MapServer/tile/{z}/{y}/{x}';
const LABELS_URL =
  'https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}';

function FitRouteBounds({ points }: { points: LatLngTuple[] }) {
  const map = useMap();

  useEffect(() => {
    if (points.length < 2) {
      return;
    }

    const bounds = latLngBounds(points);
    const fit = () => {
      map.invalidateSize(false);
      map.fitBounds(bounds, {
        padding: [30, 30],
        maxZoom: 15,
      });
    };

    const frameId = requestAnimationFrame(fit);
    const settleTimer = window.setTimeout(fit, 180);
    const animationTimer = window.setTimeout(fit, 420);

    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(() => {
        fit();
      });
      observer.observe(map.getContainer());
    }

    return () => {
      cancelAnimationFrame(frameId);
      window.clearTimeout(settleTimer);
      window.clearTimeout(animationTimer);
      observer?.disconnect();
    };
  }, [map, points]);

  return null;
}

function milestonePoints(points: LatLngTuple[]) {
  return {
    start: points[0] ?? null,
    finish: points.at(-1) ?? null,
  };
}

function paceThresholds(route: ActivityRoute) {
  const paces = route.samples
    .map((sample) => sample.paceSecondsPerKm)
    .filter((pace): pace is number => typeof pace === 'number' && Number.isFinite(pace) && pace > 0)
    .sort((left, right) => left - right);

  if (paces.length < 6) {
    return null;
  }

  const pick = (ratio: number) => paces[Math.min(paces.length - 1, Math.floor((paces.length - 1) * ratio))] ?? null;
  return {
    fast: pick(0.33),
    medium: pick(0.66),
  };
}

function paceColor(paceSecondsPerKm: number | null, thresholds: ReturnType<typeof paceThresholds>) {
  if (paceSecondsPerKm === null || !thresholds?.fast || !thresholds.medium) {
    return '#7fc5ff';
  }

  if (paceSecondsPerKm <= thresholds.fast) {
    return '#df3e3e';
  }

  if (paceSecondsPerKm <= thresholds.medium) {
    return '#f2a43c';
  }

  return '#5daeff';
}

function buildRouteSegments(route: ActivityRoute) {
  const thresholds = paceThresholds(route);

  if (route.samples.length >= 2) {
    return route.samples.slice(1).map((sample, index) => {
      const previous = route.samples[index]!;
      const segmentPace =
        sample.paceSecondsPerKm !== null && previous.paceSecondsPerKm !== null
          ? (sample.paceSecondsPerKm + previous.paceSecondsPerKm) / 2
          : sample.paceSecondsPerKm ?? previous.paceSecondsPerKm ?? null;

      return {
        positions: [previous.point as LatLngTuple, sample.point as LatLngTuple],
        color: paceColor(segmentPace, thresholds),
      };
    });
  }

  return [
    {
      positions: route.points as LatLngTuple[],
      color: '#7fc5ff',
    },
  ];
}

export function ActivityRouteMap({
  route,
  title,
}: {
  route: ActivityRoute;
  title: string;
}) {
  const points = route.points as LatLngTuple[];
  const mapKey = `${route.source}-${title}-${points.length}-${points[0]?.join('-') ?? 'route'}`;

  if (points.length < 2) {
    return (
      <div className="route-map empty">
        <span>[ SIN RUTA ]</span>
      </div>
    );
  }

  const marks = milestonePoints(points);
  const segments = buildRouteSegments(route);

  return (
    <div className="route-map" aria-label={`Mapa del recorrido de ${title}`}>
      <div className="route-map-canvas">
        <div className="route-map-hud">
          <span>Satellite relief</span>
          <strong>{title}</strong>
        </div>
        <MapContainer
          key={mapKey}
          center={points[0]}
          className="route-map-leaflet"
          dragging
          scrollWheelZoom={false}
          touchZoom
          zoomControl={false}
          zoom={13}
        >
          <FitRouteBounds points={points} />

          <TileLayer
            attribution='&copy; Esri'
            className="route-map-satellite"
            url={SATELLITE_URL}
          />

          <Pane name="relief" style={{ zIndex: 250 }}>
            <TileLayer attribution='&copy; Esri' className="route-map-hillshade" opacity={0.46} url={HILLSHADE_URL} />
          </Pane>

          <Pane name="labels" style={{ zIndex: 320 }}>
            <TileLayer attribution='&copy; Esri' className="route-map-labels" opacity={0.22} url={LABELS_URL} />
          </Pane>

          <Pane name="route-glow" style={{ zIndex: 410 }}>
            {segments.map((segment, index) => (
              <Polyline
                key={`glow-${index}`}
                pathOptions={{
                  className: 'route-line route-line-glow',
                  color: segment.color,
                  lineCap: 'round',
                  lineJoin: 'round',
                  opacity: 0.28,
                  weight: 14,
                }}
                positions={segment.positions}
              />
            ))}
          </Pane>

          <Pane name="route-shadow" style={{ zIndex: 420 }}>
            <Polyline
              pathOptions={{
                className: 'route-line route-line-shadow',
                color: 'rgba(10, 16, 24, 0.74)',
                lineCap: 'round',
                lineJoin: 'round',
                opacity: 0.75,
                weight: 12,
              }}
              positions={points}
            />
          </Pane>

          <Pane name="route-main" style={{ zIndex: 430 }}>
            {segments.map((segment, index) => (
              <Polyline
                key={`main-${index}`}
                pathOptions={{
                  className: 'route-line route-line-main',
                  color: segment.color,
                  lineCap: 'round',
                  lineJoin: 'round',
                  opacity: 0.96,
                  weight: 6,
                }}
                positions={segment.positions}
              />
            ))}
          </Pane>

          {marks.start ? (
            <CircleMarker
              center={marks.start}
              pathOptions={{ className: 'route-marker route-marker-start', color: '#f9f6eb', fillColor: '#f9f6eb', fillOpacity: 1, weight: 2 }}
              radius={5}
            >
              <Tooltip direction="top" offset={[0, -8]} opacity={0.96} permanent={false} sticky>
                Inicio
              </Tooltip>
            </CircleMarker>
          ) : null}

          {marks.finish ? (
            <CircleMarker
              center={marks.finish}
              pathOptions={{ className: 'route-marker route-marker-finish', color: '#df3e3e', fillColor: '#df3e3e', fillOpacity: 1, weight: 2 }}
              radius={5}
            >
              <Tooltip direction="top" offset={[0, -8]} opacity={0.96} permanent={false} sticky>
                Fin
              </Tooltip>
            </CircleMarker>
          ) : null}
        </MapContainer>
      </div>
      <div className="route-map-meta">
        <span>Satélite</span>
        <span>Relieve</span>
        <span>{route.source.toUpperCase()}</span>
      </div>
    </div>
  );
}

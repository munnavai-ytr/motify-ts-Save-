import { z } from 'zod';

export const EDIT_SPEC_VERSION = 2 as const;
export const EDIT_SPEC_FPS = 30 as const;
export const MAX_TIMELINE_SECONDS = 300;
export const MAX_AV_TRACKS = 12;
export const MAX_INPUT_VIDEO_BYTES = 300 * 1024 * 1024;

export const EDIT_FORMATS = ['9:16', '16:9', '1:1'] as const;
export type EditFormat = (typeof EDIT_FORMATS)[number];

export const VIDEO_FITS = ['cover', 'contain', 'blur'] as const;
export type VideoFit = (typeof VIDEO_FITS)[number];

export const CAPTION_POSITIONS = ['bottom', 'center'] as const;
export type CaptionPosition = (typeof CAPTION_POSITIONS)[number];

export const FORMAT_DIMENSIONS: Record<
  EditFormat,
  { width: number; height: number }
> = {
  '9:16': { width: 1080, height: 1920 },
  '16:9': { width: 1920, height: 1080 },
  '1:1': { width: 1080, height: 1080 },
};

export const COLOR_GRADES = [
  'none',
  'warm',
  'cool',
  'vintage',
  'noir',
  'vibrant',
] as const;
export type ColorGradePreset = (typeof COLOR_GRADES)[number];

export const OVERLAY_X_POSITIONS = ['left', 'center', 'right'] as const;
export type OverlayX = (typeof OVERLAY_X_POSITIONS)[number];

export const OVERLAY_Y_POSITIONS = ['top', 'center', 'bottom'] as const;
export type OverlayY = (typeof OVERLAY_Y_POSITIONS)[number];

export const ColorGradeSchema = z.enum(COLOR_GRADES);
export const EditFormatSchema = z.enum(EDIT_FORMATS);

export const VideoTrackSchema = z
  .object({
    kind: z.literal('video'),
    mediaId: z.string().trim().min(1, 'VideoTrack.mediaId is required'),
    startAt: z.number().finite().min(0, 'VideoTrack.startAt must be >= 0'),
    inPoint: z.number().finite().min(0, 'VideoTrack.inPoint must be >= 0'),
    outPoint: z.number().finite().positive('VideoTrack.outPoint must be > 0'),
    volume: z.number().finite().min(0).max(2).optional(),
    speed: z.number().finite().min(0.5).max(2).optional(),
    colorGrade: z.string().trim().optional(),
    fit: z.enum(VIDEO_FITS).optional(),
  })
  .refine((t) => t.outPoint > t.inPoint, {
    message: 'VideoTrack.outPoint must be greater than inPoint',
    path: ['outPoint'],
  });

export const AudioTrackSchema = z
  .object({
    kind: z.literal('audio'),
    mediaId: z.string().trim().min(1, 'AudioTrack.mediaId is required'),
    startAt: z.number().finite().min(0, 'AudioTrack.startAt must be >= 0'),
    inPoint: z.number().finite().min(0, 'AudioTrack.inPoint must be >= 0'),
    outPoint: z.number().finite().positive().optional(),
    volume: z.number().finite().min(0).max(2),
    fadeIn: z.number().finite().min(0).optional(),
    fadeOut: z.number().finite().min(0).optional(),
    loop: z.boolean().optional(),
  })
  .refine(
    (t) => t.outPoint === undefined || t.outPoint > t.inPoint,
    {
      message: 'AudioTrack.outPoint must be greater than inPoint',
      path: ['outPoint'],
    }
  );

export const OverlayBorderSchema = z.object({
  color: z.string().trim().min(1, 'Overlay border color is required'),
  width: z.number().finite().min(0).max(64),
});

export const OverlayTrackSchema = z.object({
  kind: z.literal('overlay'),
  mediaId: z.string().trim().min(1, 'OverlayTrack.mediaId is required'),
  startAt: z.number().finite().min(0, 'OverlayTrack.startAt must be >= 0'),
  duration: z.number().finite().positive('OverlayTrack.duration must be > 0'),
  x: z.enum(OVERLAY_X_POSITIONS),
  y: z.enum(OVERLAY_Y_POSITIONS),
  scale: z.number().finite().min(0.1).max(1),
  opacity: z.number().finite().min(0).max(1),
  shadow: z.boolean().optional(),
  border: OverlayBorderSchema.optional(),
});

export const MGTrackSchema = z.object({
  kind: z.literal('mg'),
  specJson: z.string().trim().min(1, 'MGTrack.specJson is required'),
  startAt: z.number().finite().min(0, 'MGTrack.startAt must be >= 0'),
  duration: z.number().finite().positive('MGTrack.duration must be > 0'),
});

export const TrackSchema = z.discriminatedUnion('kind', [
  VideoTrackSchema,
  AudioTrackSchema,
  OverlayTrackSchema,
  MGTrackSchema,
]);

export const CaptionSchema = z
  .object({
    text: z.string().trim().min(1, 'Caption.text is required'),
    start: z.number().finite().min(0, 'Caption.start must be >= 0'),
    end: z.number().finite().positive('Caption.end must be > 0'),
    position: z.enum(CAPTION_POSITIONS).default('bottom'),
  })
  .refine((c) => c.end > c.start, {
    message: 'Caption.end must be greater than start',
    path: ['end'],
  });

export const EditSpecSchema = z.object({
  v: z.literal(EDIT_SPEC_VERSION),
  format: EditFormatSchema,
  fps: z.literal(EDIT_SPEC_FPS),
  totalSeconds: z
    .number()
    .finite()
    .positive('totalSeconds must be > 0')
    .max(MAX_TIMELINE_SECONDS, `totalSeconds must be <= ${MAX_TIMELINE_SECONDS}`),
  colorGrade: ColorGradeSchema.optional(),
  tracks: z.array(TrackSchema).min(1, 'EditSpec must include at least one track'),
  captions: z.array(CaptionSchema).optional(),
});

export const EDIT_SPEC_JSON_SCHEMA: Record<string, unknown> = {
  type: 'OBJECT',
  required: ['v', 'format', 'fps', 'totalSeconds', 'tracks'],
  properties: {
    v: { type: 'INTEGER', nullable: false },
    format: {
      type: 'STRING',
      enum: [...EDIT_FORMATS],
      nullable: false,
    },
    fps: { type: 'INTEGER', nullable: false },
    totalSeconds: { type: 'NUMBER', nullable: false },
    colorGrade: {
      type: 'STRING',
      enum: [...COLOR_GRADES],
      nullable: true,
    },
    captions: {
      type: 'ARRAY',
      nullable: true,
      items: {
        type: 'OBJECT',
        required: ['text', 'start', 'end', 'position'],
        properties: {
          text: { type: 'STRING', nullable: false },
          start: { type: 'NUMBER', nullable: false },
          end: { type: 'NUMBER', nullable: false },
          position: {
            type: 'STRING',
            enum: [...CAPTION_POSITIONS],
            nullable: false,
          },
        },
      },
    },
    tracks: {
      type: 'ARRAY',
      nullable: false,
      items: {
        type: 'OBJECT',
        required: ['kind', 'startAt'],
        properties: {
          kind: {
            type: 'STRING',
            enum: ['video', 'audio', 'overlay', 'mg'],
            nullable: false,
          },
          mediaId: { type: 'STRING', nullable: true },
          startAt: { type: 'NUMBER', nullable: false },
          inPoint: { type: 'NUMBER', nullable: true },
          outPoint: { type: 'NUMBER', nullable: true },
          volume: { type: 'NUMBER', nullable: true },
          speed: { type: 'NUMBER', nullable: true },
          colorGrade: { type: 'STRING', nullable: true },
          fit: {
            type: 'STRING',
            enum: [...VIDEO_FITS],
            nullable: true,
          },
          fadeIn: { type: 'NUMBER', nullable: true },
          fadeOut: { type: 'NUMBER', nullable: true },
          loop: { type: 'BOOLEAN', nullable: true },
          duration: { type: 'NUMBER', nullable: true },
          x: {
            type: 'STRING',
            enum: [...OVERLAY_X_POSITIONS],
            nullable: true,
          },
          y: {
            type: 'STRING',
            enum: [...OVERLAY_Y_POSITIONS],
            nullable: true,
          },
          scale: { type: 'NUMBER', nullable: true },
          opacity: { type: 'NUMBER', nullable: true },
          shadow: { type: 'BOOLEAN', nullable: true },
          border: {
            type: 'OBJECT',
            nullable: true,
            required: ['color', 'width'],
            properties: {
              color: { type: 'STRING', nullable: false },
              width: { type: 'NUMBER', nullable: false },
            },
          },
          specJson: { type: 'STRING', nullable: true },
        },
      },
    },
  },
};

export type VideoTrack = z.infer<typeof VideoTrackSchema>;
export type AudioTrack = z.infer<typeof AudioTrackSchema>;
export type OverlayBorder = z.infer<typeof OverlayBorderSchema>;
export type OverlayTrack = z.infer<typeof OverlayTrackSchema>;
export type MGTrack = z.infer<typeof MGTrackSchema>;
export type Track = z.infer<typeof TrackSchema>;
export type CaptionItem = z.infer<typeof CaptionSchema>;
export type EditSpec = z.infer<typeof EditSpecSchema>;

export type NormalizeEditSpecResult =
  | { ok: true; spec: EditSpec; warnings: string[] }
  | { ok: false; errors: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clampWithWarning(
  val: number,
  min: number,
  max: number,
  label: string,
  warnings: string[]
): number {
  if (val < min) {
    warnings.push(`${label} (${val}) was clamped to minimum ${min}.`);
    return min;
  }
  if (val > max) {
    warnings.push(`${label} (${val}) was clamped to maximum ${max}.`);
    return max;
  }
  return val;
}

function isKnownColorGrade(value: string): value is ColorGradePreset {
  return (COLOR_GRADES as readonly string[]).includes(value);
}

function isKnownVideoFit(value: string): value is VideoFit {
  return (VIDEO_FITS as readonly string[]).includes(value);
}

function stripNullOptionalKeys(
  obj: Record<string, unknown>,
  keys: readonly string[]
): void {
  for (const key of keys) {
    if (obj[key] === null) {
      delete obj[key];
    }
  }
}

export function normalizeEditSpec(raw: unknown): NormalizeEditSpecResult {
  const warnings: string[] = [];
  let parsedInput: unknown = raw;

  if (typeof raw === 'string') {
    try {
      parsedInput = JSON.parse(raw) as unknown;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Invalid JSON string';
      return { ok: false, errors: [`Failed to parse EditSpec JSON: ${message}`] };
    }
  }

  if (!isRecord(parsedInput)) {
    return { ok: false, errors: ['EditSpec must be a JSON object.'] };
  }

  const candidate: Record<string, unknown> = { ...parsedInput };
  stripNullOptionalKeys(candidate, ['colorGrade', 'captions']);

  if (candidate.v === undefined) {
    candidate.v = EDIT_SPEC_VERSION;
    warnings.push('Missing "v" field; defaulted to 2.');
  }

  if (candidate.fps === undefined) {
    candidate.fps = EDIT_SPEC_FPS;
    warnings.push('Missing "fps" field; defaulted to 30.');
  } else if (typeof candidate.fps === 'number' && candidate.fps !== EDIT_SPEC_FPS) {
    warnings.push(`fps (${candidate.fps}) normalized to ${EDIT_SPEC_FPS}.`);
    candidate.fps = EDIT_SPEC_FPS;
  }

  if (typeof candidate.colorGrade === 'string') {
    const trimmed = candidate.colorGrade.trim().toLowerCase();
    if (!isKnownColorGrade(trimmed)) {
      warnings.push(
        `Unknown top-level colorGrade "${candidate.colorGrade}"; defaulted to "none".`
      );
      candidate.colorGrade = 'none';
    } else {
      candidate.colorGrade = trimmed;
    }
  }

  if (Array.isArray(candidate.captions)) {
    candidate.captions = candidate.captions
      .filter((entry): entry is Record<string, unknown> => isRecord(entry))
      .map((entry) => {
        const next: Record<string, unknown> = { ...entry };
        if (typeof next.position === 'string') {
          const pos = next.position.trim().toLowerCase();
          next.position = pos === 'center' ? 'center' : 'bottom';
        } else if (next.position === undefined || next.position === null) {
          next.position = 'bottom';
        }
        return next;
      });
  }

  if (Array.isArray(candidate.tracks)) {
    candidate.tracks = candidate.tracks.map((rawTrack, index) => {
      if (!isRecord(rawTrack)) return rawTrack;
      const track: Record<string, unknown> = { ...rawTrack };
      stripNullOptionalKeys(track, [
        'mediaId',
        'inPoint',
        'outPoint',
        'volume',
        'speed',
        'colorGrade',
        'fit',
        'fadeIn',
        'fadeOut',
        'loop',
        'duration',
        'x',
        'y',
        'scale',
        'opacity',
        'shadow',
        'border',
        'specJson',
      ]);
      const kind = track.kind;

      if (kind === 'video') {
        if (typeof track.volume === 'number' && Number.isFinite(track.volume)) {
          track.volume = clampWithWarning(
            track.volume,
            0,
            2,
            `tracks[${index}].volume`,
            warnings
          );
        }
        if (typeof track.speed === 'number' && Number.isFinite(track.speed)) {
          track.speed = clampWithWarning(
            track.speed,
            0.5,
            2,
            `tracks[${index}].speed`,
            warnings
          );
        }
        if (typeof track.colorGrade === 'string') {
          const normalizedGrade = track.colorGrade.trim().toLowerCase();
          if (normalizedGrade && !isKnownColorGrade(normalizedGrade)) {
            warnings.push(
              `tracks[${index}].colorGrade "${track.colorGrade}" is not a built-in preset; keeping custom value or ignoring during render.`
            );
          }
          track.colorGrade = normalizedGrade;
        }
        if (typeof track.fit === 'string') {
          const normalizedFit = track.fit.trim().toLowerCase();
          if (!isKnownVideoFit(normalizedFit)) {
            warnings.push(
              `tracks[${index}].fit "${track.fit}" is unknown; defaulted to "cover".`
            );
            track.fit = 'cover';
          } else {
            track.fit = normalizedFit;
          }
        }
      } else if (kind === 'audio') {
        if (track.inPoint === undefined) {
          track.inPoint = 0;
          warnings.push(`tracks[${index}].inPoint defaulted to 0.`);
        }
        if (track.volume === undefined) {
          track.volume = 1;
          warnings.push(`tracks[${index}].volume defaulted to 1.`);
        } else if (typeof track.volume === 'number' && Number.isFinite(track.volume)) {
          track.volume = clampWithWarning(
            track.volume,
            0,
            2,
            `tracks[${index}].volume`,
            warnings
          );
        }
      } else if (kind === 'overlay') {
        if (track.x === undefined) {
          track.x = 'center';
          warnings.push(`tracks[${index}].x defaulted to "center".`);
        }
        if (track.y === undefined) {
          track.y = 'center';
          warnings.push(`tracks[${index}].y defaulted to "center".`);
        }
        if (typeof track.scale === 'number' && Number.isFinite(track.scale)) {
          track.scale = clampWithWarning(
            track.scale,
            0.1,
            1,
            `tracks[${index}].scale`,
            warnings
          );
        }
        if (typeof track.opacity === 'number' && Number.isFinite(track.opacity)) {
          track.opacity = clampWithWarning(
            track.opacity,
            0,
            1,
            `tracks[${index}].opacity`,
            warnings
          );
        }
      }

      return track;
    });
  }

  const result = EditSpecSchema.safeParse(candidate);
  if (!result.success) {
    const errors = result.error.issues.map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : 'root';
      return `${path}: ${issue.message}`;
    });
    return { ok: false, errors };
  }

  const spec = result.data;

  const avCount = spec.tracks.filter(
    (t) => t.kind === 'video' || t.kind === 'audio'
  ).length;
  if (avCount > MAX_AV_TRACKS) {
    return {
      ok: false,
      errors: [
        `Too many video/audio tracks (${avCount}). Maximum allowed is ${MAX_AV_TRACKS}.`,
      ],
    };
  }

  const videoTracks = spec.tracks.filter(
    (t): t is VideoTrack => t.kind === 'video'
  );
  const mgTracks = spec.tracks.filter((t): t is MGTrack => t.kind === 'mg');
  if (videoTracks.length === 0 && mgTracks.length === 0) {
    warnings.push('No VideoTrack present; compositor will generate a black base canvas.');
  }

  return { ok: true, spec, warnings };
}


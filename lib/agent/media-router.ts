import {
  buildThinkingConfig,
  type GeminiStatusEvent,
} from '@/lib/ai/gemini-client';
import { callGeminiWithPolicy } from '@/lib/ai/gemini-policy';
import { extractJsonFromText } from '@/lib/ai/plan-schema';
import { isBengaliText } from '@/lib/agent/intent';
import {
  isKitVideoMessage,
  isLegacyVideoMessage,
  isMediaVideoMessage,
  type ChatMessage,
  type MediaKind,
} from '@/lib/types';

export type MediaRouteKind = 'motion' | 'media' | 'hybrid' | 'reply';

export interface RouterAttachmentInput {
  mediaId: string;
  kind: MediaKind;
  name: string;
}

export interface RouteTurnParams {
  userText: string;
  currentAttachments: ReadonlyArray<RouterAttachmentInput>;
  messages: ReadonlyArray<ChatMessage>;
  useMediaEnabled: boolean;
  apiKey?: string;
  modelName?: string;
  backupModelName?: string;
  signal?: AbortSignal;
  onStatus?: (event: GeminiStatusEvent) => void;
}

export interface RouteTurnResult {
  route: MediaRouteKind;
  reason: string;
  useFootage: boolean;
  referenceOnly: boolean;
  editExisting: boolean;
  targetMediaVideoId?: string;
  referenceMediaIds: string[];
  usedAiClassifier: boolean;
  usage?: {
    requests: number;
    promptTokens: number;
    outputTokens: number;
    thoughtTokens: number;
    modelName?: string;
    usedBackup?: boolean;
  };
}

function unicodeWordBoundaryRegex(pattern: string): RegExp {
  return new RegExp(
    `(?<![\\p{L}\\p{M}\\p{N}_])(?:${pattern})(?![\\p{L}\\p{M}\\p{N}_])`,
    'iu'
  );
}

const GREETING_OR_QUESTION_RE =
  /^(?:hi|hello|hey|yo|sup|hii+|helo+|good morning|good afternoon|good evening|thanks|thank you|ok thanks|salam|assalamu\s*alaikum|nomoshkar|নমস্কার|হ্যালো|হ্যালোও*|হাই|সালাম|আসসালামু\s*আলাইকুম|কেমন আছ|ধন্যবাদ|সুপ্রভাত)[!.,।\s]*$/iu;

const REFERENCE_INTENT_RE = unicodeWordBoundaryRegex(
  'same style|like this|in this style|copy this style|reference|as a reference|inspired by|mimic this|match this style|style reference'
);
const REFERENCE_INTENT_BN_RE =
  /(?<![\p{L}\p{M}\p{N}_])(?:এই স্টাইলে|এই ভিডিওর মতো|সেম স্টাইল|রেফারেন্স|এর মতো)/u;

const FOOTAGE_USE_RE = unicodeWordBoundaryRegex(
  'use my|use these|use this|with my|from my|my clips?|my videos?|my photos?|my pictures?|my images?|my footage|assemble|edit|cut|trim|highlight|reel|combine|merge|compile|montage|slideshow|color grade|grade|captions?|subtitles?|slow motion|speed up|blur|crop|fit|make a video with|put together'
);
const FOOTAGE_USE_BN_RE =
  /(?<![\p{L}\p{M}\p{N}_])(?:আমার ভিডিও|আমার ছবি|এই ভিডিও|এগুলো দিয়ে|এগুলা দিয়ে|ব্যবহার করে|এডিট|কাট|ট্রিম|রিল|জোড়া|কম্বাইন|বানিয়ে দাও|বানাও|তৈরি করো)/u;

const HYBRID_INTENT_RE = unicodeWordBoundaryRegex(
  'intro|outro|title card|title screen|titles?|branding|motion graphics?|cta|call to action|lower[- ]?third|subscribe|animated text|opener|end screen'
);
const HYBRID_INTENT_BN_RE =
  /(?<![\p{L}\p{M}\p{N}_])(?:ইন্ট্রো|আউট্রো|টাইটেল|মোশন গ্রাফিক্স|ব্র্যান্ডিং)/u;

const PURE_MOTION_SWITCH_RE = unicodeWordBoundaryRegex(
  '2d motion graphics|animated typography|no footage|without my video|without footage|pure motion|motion graphic explainer'
);

const EDIT_ACTION_VERB_RE =
  /(?<![\p{L}\p{M}\p{N}_])(?:(?:make|change|trim|cut|short|shorten|long|lengthen|add|remove|delete|replace|update|fix|warm|cool|vintage|noir|vibrant|bright|dark|fast|faster|slow|slower|louder|quieter|mute|volume|music|audio|caption|subtitle|blur|cover|contain|intro|outro|title|cta|grade|color|format|vertical|landscape|square|9:16|16:9|1:1)|(?:এডিট|কাট|ছোট|বড়|রঙ|মিউজিক|স্লো|ফাস্ট|টাইটেল|ইন্ট্রো|আউট্রো)(?:টা|টি|গুলো|গুলা|ের|ে)?)(?![\p{L}\p{M}\p{N}_])/iu;

function hasReferenceIntent(text: string): boolean {
  return REFERENCE_INTENT_RE.test(text) || REFERENCE_INTENT_BN_RE.test(text);
}

function hasFootageUseIntent(text: string): boolean {
  return FOOTAGE_USE_RE.test(text) || FOOTAGE_USE_BN_RE.test(text);
}

function hasHybridIntent(text: string): boolean {
  return HYBRID_INTENT_RE.test(text) || HYBRID_INTENT_BN_RE.test(text);
}

function isPureQuestionOrGreeting(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (GREETING_OR_QUESTION_RE.test(trimmed)) return true;
  if (
    (trimmed.endsWith('?') || trimmed.endsWith('？')) &&
    !EDIT_ACTION_VERB_RE.test(trimmed) &&
    !hasFootageUseIntent(trimmed) &&
    !hasHybridIntent(trimmed)
  ) {
    return true;
  }
  return false;
}

function pickReferenceIdsFromText(
  text: string,
  visualAttachments: ReadonlyArray<RouterAttachmentInput>
): string[] {
  if (visualAttachments.length === 0) return [];
  if (visualAttachments.length === 1) {
    return [visualAttachments[0].mediaId];
  }
  const lower = text.toLowerCase();
  const explicitMatches = visualAttachments
    .filter((att) => lower.includes(att.name.toLowerCase()))
    .map((att) => att.mediaId);
  if (explicitMatches.length > 0 && explicitMatches.length < visualAttachments.length) {
    return explicitMatches;
  }
  // If multiple visual attachments and user says "like this / reference", treat the first clip as reference
  return [visualAttachments[0].mediaId];
}

export async function routeTurn(
  params: RouteTurnParams
): Promise<RouteTurnResult> {
  const text = params.userText.trim();
  const isBn = isBengaliText(text);
  const visualAttachments = params.currentAttachments.filter(
    (a) => a.kind === 'video' || a.kind === 'image'
  );
  const hasVisualAttachments = visualAttachments.length > 0;

  let latestMediaVideoId: string | undefined;
  let latestMediaCreatedAt = -1;
  let latestMotionCreatedAt = -1;

  for (const msg of params.messages) {
    if (isMediaVideoMessage(msg) && msg.createdAt >= latestMediaCreatedAt) {
      latestMediaCreatedAt = msg.createdAt;
      latestMediaVideoId = msg.id;
    } else if (
      (isKitVideoMessage(msg) ||
        (isLegacyVideoMessage(msg) && msg.status !== 'superseded')) &&
      msg.createdAt >= latestMotionCreatedAt
    ) {
      latestMotionCreatedAt = msg.createdAt;
    }
  }

  const hasExistingMediaVideo = latestMediaCreatedAt >= 0;
  const mediaVideoIsLatest =
    hasExistingMediaVideo && latestMediaCreatedAt >= latestMotionCreatedAt;

  // Respect Settings toggle ("Use my uploaded media automatically")
  if (!params.useMediaEnabled) {
    return {
      route: isPureQuestionOrGreeting(text) && !hasVisualAttachments ? 'reply' : 'motion',
      reason: 'Automatic media editing is disabled in Settings; using Motion Graphics mode.',
      useFootage: false,
      referenceOnly: false,
      editExisting: false,
      referenceMediaIds: [],
      usedAiClassifier: false,
    };
  }

  // Rule 1: No video/image attachments in this turn and no existing media edit in project
  if (!hasVisualAttachments && !hasExistingMediaVideo) {
    if (isPureQuestionOrGreeting(text)) {
      return {
        route: 'reply',
        reason: isBn
          ? 'সাধারণ প্রশ্ন বা শুভেচ্ছা — কথোপকথন উত্তর দিচ্ছি।'
          : 'Conversational question or greeting with no media attachments.',
        useFootage: false,
        referenceOnly: false,
        editExisting: false,
        referenceMediaIds: [],
        usedAiClassifier: false,
      };
    }
    return {
      route: 'motion',
      reason: 'No uploaded video or photo footage in this chat; routing to Motion Graphics Director.',
      useFootage: false,
      referenceOnly: false,
      editExisting: false,
      referenceMediaIds: [],
      usedAiClassifier: false,
    };
  }

  // Rule 2: Explicit style reference intent when visual attachments are provided
  if (hasVisualAttachments && hasReferenceIntent(text)) {
    const referenceMediaIds = pickReferenceIdsFromText(text, visualAttachments);
    const hasTimelineFootage =
      visualAttachments.some((a) => !referenceMediaIds.includes(a.mediaId)) ||
      (hasExistingMediaVideo && !PURE_MOTION_SWITCH_RE.test(text));

    if (!hasTimelineFootage) {
      return {
        route: 'motion',
        reason: isBn
          ? 'রেফারেন্স স্টাইল বিশ্লেষণ করে মোশন গ্রাফিক্স তৈরি করছি (রেফারেন্স ক্লিপ টাইমলাইনে রাখা হবে না)।'
          : 'Reference style requested; analyzing attachment as style inspiration only (not placed on timeline).',
        useFootage: false,
        referenceOnly: true,
        editExisting: false,
        referenceMediaIds,
        usedAiClassifier: false,
      };
    }

    const hybrid = hasHybridIntent(text);
    return {
      route: hybrid ? 'hybrid' : 'media',
      reason: hybrid
        ? 'Style reference + footage + motion graphics titles/CTA requested.'
        : 'Applying reference video style to your timeline footage (reference clip excluded from timeline).',
      useFootage: true,
      referenceOnly: true,
      editExisting: !visualAttachments.some((a) => !referenceMediaIds.includes(a.mediaId)) && hasExistingMediaVideo,
      ...(hasExistingMediaVideo && !visualAttachments.some((a) => !referenceMediaIds.includes(a.mediaId))
        ? { targetMediaVideoId: latestMediaVideoId }
        : {}),
      referenceMediaIds,
      usedAiClassifier: false,
    };
  }

  // Rule 3 & Rule 4: Visual attachments uploaded in this turn
  if (hasVisualAttachments) {
    if (PURE_MOTION_SWITCH_RE.test(text)) {
      return {
        route: 'motion',
        reason: 'User asked for pure 2D motion graphics without raw footage.',
        useFootage: false,
        referenceOnly: true,
        editExisting: false,
        referenceMediaIds: visualAttachments.map((a) => a.mediaId),
        usedAiClassifier: false,
      };
    }

    // Pure question about an attached image/video without asking to make/edit a video
    if (isPureQuestionOrGreeting(text) && text.trim().length > 0) {
      return {
        route: 'reply',
        reason: 'User asked a question about the attached media without requesting a video build.',
        useFootage: false,
        referenceOnly: true,
        editExisting: false,
        referenceMediaIds: [],
        usedAiClassifier: false,
      };
    }

    const hybrid = hasHybridIntent(text);
    const footageExplicit = hasFootageUseIntent(text);
    const looksActionableOrEmpty =
      text.length === 0 ||
      footageExplicit ||
      hybrid ||
      EDIT_ACTION_VERB_RE.test(text) ||
      text.split(/\s+/).length <= 16;

    if (looksActionableOrEmpty) {
      return {
        route: hybrid ? 'hybrid' : 'media',
        reason: hybrid
          ? 'Combining your uploaded footage with motion-graphics titles/CTA.'
          : footageExplicit
            ? 'Editing and assembling your uploaded footage.'
            : 'Using your uploaded media to assemble a video edit.',
        useFootage: true,
        referenceOnly: false,
        editExisting: false,
        referenceMediaIds: [],
        usedAiClassifier: false,
      };
    }
  }

  // Rule 5: Follow-up turn without new visual attachments when a media edit exists
  if (!hasVisualAttachments && hasExistingMediaVideo) {
    if (PURE_MOTION_SWITCH_RE.test(text)) {
      return {
        route: 'motion',
        reason: 'Switching to 2D Motion Graphics mode as requested.',
        useFootage: false,
        referenceOnly: false,
        editExisting: false,
        referenceMediaIds: [],
        usedAiClassifier: false,
      };
    }

    if (isPureQuestionOrGreeting(text)) {
      return {
        route: 'reply',
        reason: 'Conversational question about the current project.',
        useFootage: false,
        referenceOnly: false,
        editExisting: false,
        referenceMediaIds: [],
        usedAiClassifier: false,
      };
    }

    if (
      mediaVideoIsLatest &&
      (EDIT_ACTION_VERB_RE.test(text) ||
        hasFootageUseIntent(text) ||
        hasHybridIntent(text) ||
        params.currentAttachments.some((a) => a.kind === 'audio'))
    ) {
      const hybrid = hasHybridIntent(text);
      return {
        route: hybrid ? 'hybrid' : 'media',
        reason: hybrid
          ? 'Updating your media edit with motion-graphics intro/outro.'
          : 'Revising your existing media edit.',
        useFootage: true,
        referenceOnly: false,
        editExisting: true,
        targetMediaVideoId: latestMediaVideoId,
        referenceMediaIds: [],
        usedAiClassifier: false,
      };
    }
  }

  // Rule 6: Ambiguous — at most ONE small AI classifier call
  if (params.apiKey && params.modelName) {
    try {
      const attachmentSummary =
        params.currentAttachments.length > 0
          ? params.currentAttachments.map((a) => `${a.kind}:${a.name}`).join(', ')
          : 'none in this message';
      const classifierRes = await callGeminiWithPolicy({
        apiKey: params.apiKey,
        modelName: params.modelName,
        backupModelName: params.backupModelName,
        systemInstruction:
          'Classify the user turn for a video studio. Options: "media" (edit/assemble user footage/photos), "hybrid" (user footage + motion graphics titles/intro/outro/CTA), "motion" (2D animated motion graphics without raw footage, or using attachment only as style reference), "reply" (general chat/question). Return JSON only: {"route":"media"|"hybrid"|"motion"|"reply","reason":"short 1-sentence reason"}.',
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: `User message: "${text}"\nAttachments in turn: ${attachmentSummary}\nLatest video in project is media edit: ${mediaVideoIsLatest}`,
              },
            ],
          },
        ],
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'OBJECT',
          required: ['route', 'reason'],
          properties: {
            route: {
              type: 'STRING',
              enum: ['motion', 'media', 'hybrid', 'reply'],
              nullable: false,
            },
            reason: { type: 'STRING', nullable: false },
          },
        },
        temperature: 0.1,
        maxOutputTokens: 150,
        thinkingConfig: buildThinkingConfig(params.modelName),
        onStatus: params.onStatus,
        signal: params.signal,
      });

      const parsed = extractJsonFromText(classifierRes.text) as {
        route?: unknown;
        reason?: unknown;
      };
      const picked: MediaRouteKind =
        parsed.route === 'media' ||
        parsed.route === 'hybrid' ||
        parsed.route === 'motion' ||
        parsed.route === 'reply'
          ? parsed.route
          : hasVisualAttachments
            ? 'media'
            : 'motion';
      const reason =
        typeof parsed.reason === 'string' && parsed.reason.trim().length > 0
          ? parsed.reason.trim()
          : `Classified turn as ${picked}.`;

      const usage = {
        requests: 1,
        promptTokens: classifierRes.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: classifierRes.usageMetadata?.candidatesTokenCount ?? 0,
        thoughtTokens: classifierRes.usageMetadata?.thoughtsTokenCount ?? 0,
        modelName: classifierRes.answeringModel,
        usedBackup: classifierRes.usedBackup,
      };

      return {
        route: picked,
        reason,
        useFootage: picked === 'media' || picked === 'hybrid',
        referenceOnly: picked === 'motion' && hasVisualAttachments,
        editExisting:
          (picked === 'media' || picked === 'hybrid') &&
          !hasVisualAttachments &&
          hasExistingMediaVideo,
        ...(hasExistingMediaVideo && !hasVisualAttachments
          ? { targetMediaVideoId: latestMediaVideoId }
          : {}),
        referenceMediaIds:
          picked === 'motion' && hasVisualAttachments
            ? visualAttachments.map((a) => a.mediaId)
            : [],
        usedAiClassifier: true,
        usage,
      };
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw err;
      }
      // Fall back deterministically if tiny classifier call fails
    }
  }

  if (hasVisualAttachments) {
    return {
      route: 'media',
      reason: 'Defaulting to Media Edit for uploaded footage/photos.',
      useFootage: true,
      referenceOnly: false,
      editExisting: false,
      referenceMediaIds: [],
      usedAiClassifier: false,
    };
  }

  return {
    route: mediaVideoIsLatest ? 'media' : 'motion',
    reason: mediaVideoIsLatest
      ? 'Continuing edit on your current media video.'
      : 'Routing to Motion Graphics Director.',
    useFootage: mediaVideoIsLatest,
    referenceOnly: false,
    editExisting: mediaVideoIsLatest,
    ...(mediaVideoIsLatest ? { targetMediaVideoId: latestMediaVideoId } : {}),
    referenceMediaIds: [],
    usedAiClassifier: false,
  };
}

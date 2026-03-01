import { power_user } from '../../../../../scripts/power-user.js';

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function stripReasoningBlocks(rawText, context) {
  let text = String(rawText || '');

  const parseReasoning = context?.parseReasoningFromString;
  if (typeof parseReasoning === 'function') {
    for (let index = 0; index < 20; index += 1) {
      const parsed = parseReasoning(text, { strict: false });
      if (!parsed || typeof parsed.content !== 'string') {
        break;
      }

      const next = String(parsed.content || '');
      if (next === text) {
        break;
      }

      text = next;
    }
  }

  const prefix = String(power_user?.reasoning?.prefix || '').trim();
  const suffix = String(power_user?.reasoning?.suffix || '').trim();
  if (prefix && suffix) {
    const pattern = new RegExp(`${escapeRegex(prefix)}[\\s\\S]*?${escapeRegex(suffix)}`, 'gi');
    text = text.replace(pattern, ' ');
  }

  text = text
    .replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, ' ')
    .replace(/<thinking\b[^>]*>[\s\S]*?<\/thinking>/gi, ' ');

  return text;
}

export function extractJsonArrayFromLlmResponse(rawText, context) {
  const text = stripReasoningBlocks(String(rawText || ''), context).trim();

  const tryParse = (candidate) => {
    try {
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed)) {
        return parsed;
      }
      return null;
    } catch (error) {
      return null;
    }
  };

  const direct = tryParse(text);
  if (direct) {
    return direct;
  }

  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== '[') {
      continue;
    }

    let depth = 0;
    for (let index = start; index < text.length; index += 1) {
      const char = text[index];
      if (char === '[') {
        depth += 1;
      } else if (char === ']') {
        depth -= 1;
        if (depth === 0) {
          const snippet = text.slice(start, index + 1);
          const parsed = tryParse(snippet);
          if (parsed) {
            return parsed;
          }
          break;
        }
      }
    }
  }

  const firstBracket = text.indexOf('[');
  const lastQuoteComma = text.lastIndexOf('",');
  if (firstBracket !== -1 && lastQuoteComma !== -1 && lastQuoteComma > firstBracket) {
    const truncatedCandidate = text.slice(firstBracket, lastQuoteComma + 2);
    const rescuedCandidate = `${truncatedCandidate.slice(0, -1)}]`;
    const rescued = tryParse(rescuedCandidate);
    if (rescued) {
      return rescued;
    }
  }

  return [];
}

function hasUnclosedThinkBlock(rawText) {
  const text = String(rawText || '').toLowerCase();
  const hasUnclosed = (tag) => {
    const openIndex = text.lastIndexOf(`<${tag}`);
    const closeIndex = text.lastIndexOf(`</${tag}>`);
    return openIndex !== -1 && openIndex > closeIndex;
  };

  return hasUnclosed('think') || hasUnclosed('thinking');
}

function dedupeStringArray(values) {
  const unique = new Set();
  const result = [];

  for (const value of Array.isArray(values) ? values : []) {
    const token = String(value || '').trim();
    if (!token || unique.has(token)) {
      continue;
    }

    unique.add(token);
    result.push(token);
  }

  return result;
}

function isStrictClosedArrayMalformed(nonThinkText) {
  const text = String(nonThinkText || '');
  const openIndex = text.indexOf('[');
  const closeIndex = text.lastIndexOf(']');
  if (openIndex === -1 || closeIndex === -1 || closeIndex <= openIndex) {
    return false;
  }

  const closedCandidate = text.slice(openIndex, closeIndex + 1);
  try {
    const parsed = JSON.parse(closedCandidate);
    return !Array.isArray(parsed);
  } catch (error) {
    return true;
  }
}

function evaluateStreamingText(rawText, context, options = {}) {
  if (hasUnclosedThinkBlock(rawText)) {
    return {
      shouldAbort: false,
      abortReason: null,
      parsedCandidates: [],
      hasArrayStart: false,
      nonThinkLength: 0,
    };
  }

  const nonThinkText = stripReasoningBlocks(String(rawText || ''), context).trim();
  const hasArrayStart = nonThinkText.includes('[');
  const nonThinkLength = nonThinkText.length;

  if (!hasArrayStart && nonThinkLength >= 300) {
    return {
      shouldAbort: true,
      abortReason: 'no-table',
      parsedCandidates: [],
      hasArrayStart,
      nonThinkLength,
    };
  }

  const parsedCandidates = dedupeStringArray(extractJsonArrayFromLlmResponse(rawText, context));
  const limit = Number(options?.limit) > 0 ? Math.floor(Number(options.limit)) : 0;

  if (limit > 0 && parsedCandidates.length > limit) {
    return {
      shouldAbort: true,
      abortReason: 'over-limit',
      parsedCandidates,
      hasArrayStart,
      nonThinkLength,
    };
  }

  const allowedValues = Array.isArray(options?.allowedValues) ? options.allowedValues : [];
  const allowedSet = new Set(allowedValues.map((item) => String(item || '').trim()).filter(Boolean));

  if (allowedSet.size > 0 && parsedCandidates.length >= 5) {
    const lastFive = parsedCandidates.slice(-5);
    const allUnknown = lastFive.every((candidate) => !allowedSet.has(candidate));
    if (allUnknown) {
      return {
        shouldAbort: true,
        abortReason: 'gibberish',
        parsedCandidates,
        hasArrayStart,
        nonThinkLength,
      };
    }
  }

  if (hasArrayStart && isStrictClosedArrayMalformed(nonThinkText)) {
    return {
      shouldAbort: true,
      abortReason: 'malformed',
      parsedCandidates,
      hasArrayStart,
      nonThinkLength,
    };
  }

  return {
    shouldAbort: false,
    abortReason: null,
    parsedCandidates,
    hasArrayStart,
    nonThinkLength,
  };
}

async function generateWithStreaming(context, promptText, options = {}) {
  const eventSource = context?.eventSource;
  const streamEvent = context?.eventTypes?.STREAM_TOKEN_RECEIVED;
  const canStream = typeof context?.generate === 'function'
    && typeof context?.stopGeneration === 'function'
    && eventSource
    && streamEvent;

  if (!canStream) {
    return null;
  }

  const sendTextarea = $('#send_textarea');
  const previousInputValue = sendTextarea.length ? String(sendTextarea.val() || '') : '';

  let latestStreamText = '';
  let lastGoodCandidates = [];
  let abortReason = null;
  let abortTriggered = false;
  let sawArrayStart = false;

  const onStreamToken = (text) => {
    latestStreamText = String(text || '');
    const evaluation = evaluateStreamingText(latestStreamText, context, options);
    sawArrayStart = sawArrayStart || evaluation.hasArrayStart;

    if (evaluation.parsedCandidates.length > 0) {
      lastGoodCandidates = evaluation.parsedCandidates.slice();
    }

    if (evaluation.shouldAbort && !abortTriggered) {
      abortTriggered = true;
      abortReason = evaluation.abortReason;
      context.stopGeneration();
    }
  };

  eventSource.on(streamEvent, onStreamToken);

  let response = '';
  let generationError = null;
  try {
    response = await context.generate('impersonate', {
      automatic_trigger: true,
      force_name2: true,
      quiet_prompt: promptText,
      quietToLoud: false,
    });
  } catch (error) {
    generationError = error;
  } finally {
    eventSource.removeListener(streamEvent, onStreamToken);
    if (sendTextarea.length) {
      sendTextarea.val(previousInputValue);
      const element = sendTextarea.get(0);
      element?.dispatchEvent?.(new Event('input', { bubbles: true }));
    }
  }

  if (generationError && !abortTriggered) {
    throw generationError;
  }

  const finalText = String(latestStreamText || response || '');
  let finalCandidates = dedupeStringArray(extractJsonArrayFromLlmResponse(finalText, context));
  if (finalCandidates.length === 0 && lastGoodCandidates.length > 0) {
    finalCandidates = lastGoodCandidates.slice();
  }

  const limit = Number(options?.limit) > 0 ? Math.floor(Number(options.limit)) : 0;
  if (limit > 0 && finalCandidates.length > limit) {
    finalCandidates = finalCandidates.slice(0, limit);
  }

  if (abortReason === 'no-table' && !sawArrayStart && finalCandidates.length === 0 && typeof options?.onNoTableAbort === 'function') {
    options.onNoTableAbort();
  }

  return finalCandidates;
}

export async function generateJsonArrayWithLlm(context, systemPrompt, userPrompt, options = {}) {
  let response = '';
  const mergedPrompt = `${String(systemPrompt || '')}\n\n${String(userPrompt || '')}`;

  const streamResult = await generateWithStreaming(context, mergedPrompt, options);
  if (Array.isArray(streamResult)) {
    return streamResult;
  }

  if (context?.generateRaw) {
    response = await context.generateRaw({
      prompt: [
        { role: 'system', content: String(systemPrompt || '') },
        { role: 'user', content: String(userPrompt || '') },
      ],
      quietToLoud: false,
    });
  } else if (context?.generateQuietPrompt) {
    response = await context.generateQuietPrompt({
      quietPrompt: mergedPrompt,
      quietToLoud: false,
    });
  } else if (context?.generate) {
    response = await context.generate(mergedPrompt, {
      reasoning_effort: 'min',
      include_reasoning: false,
      request_thoughts: false,
    });
  } else {
    throw new Error('No generation function available');
  }

  const parsed = dedupeStringArray(extractJsonArrayFromLlmResponse(response, context));
  const limit = Number(options?.limit) > 0 ? Math.floor(Number(options.limit)) : 0;
  if (limit > 0 && parsed.length > limit) {
    return parsed.slice(0, limit);
  }

  return parsed;
}

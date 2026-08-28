const {
  sanitizationMiddleware: sanitize,
} = require('../../middleware/sanitize');
const { z } = require('zod');
const { toSchema } = require('../../utils/schemaHelper');
const auth = require('../../middleware/auth');
const rbac = require('../../middleware/rbac');
const aiRepo = require('./repository');
const config = require('../../config');
const {
  generateAIResponse,
  generateAIImage,
  getProviderHealth,
} = require('../../services/aiProviderService');

const AI_CHAT_RATE_LIMIT = Number(process.env.AI_CHAT_RATE_LIMIT_PER_MIN || 10);

const chatBodySchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant', 'system']),
        content: z.string(),
      })
    )
    .optional(),
  prompt: z.string().optional(),
});

async function routes(fastify) {
  fastify.post(
    '/chat',
    {
      schema: {
        tags: ['AI'],
        description: 'Send chat message to AI',
        body: toSchema(chatBodySchema),
      },
      preHandler: [auth, rbac('ADMIN', 'SENIOR_TL', 'TL'), sanitize],
      // Keep Fastify's parser limit aligned with the maximum payload we accept.
      bodyLimit: 2 * 1024 * 1024, // 2 MB
      config: {
        rateLimit: {
          max: AI_CHAT_RATE_LIMIT,
          timeWindow: '1 minute',
          keyGenerator: (req) => {
            if (req.user?.id) return req.user.id;
            const authHeader = req.headers.authorization;
            if (authHeader && authHeader.startsWith('Bearer ')) {
              try {
                const { verifyAccessToken } = require('../../utils/tokens');
                const decoded = verifyAccessToken(authHeader.split(' ')[1]);
                return decoded.id;
              } catch (err) {}
            }
            return req.ip;
          },
        },
      },
    },
    async (req, reply) => {
      //Requests larger than 2 MB are rejected by Fastify via `bodyLimit`

      const ALLOWED_ROLES = ['user', 'assistant', 'system'];

      let finalMessages = [];
      const { messages, prompt } = req.body || {};

      if (Array.isArray(messages)) {
        for (const msg of messages) {
          if (
            !msg ||
            typeof msg !== 'object' ||
            !ALLOWED_ROLES.includes(msg.role)
          ) {
            return reply.status(400).send({
              error: 'Invalid message role',
            });
          }
        }

        finalMessages = messages.slice(0, 16).map((msg) => ({
          role: msg.role,
          content: String(msg.content || '').slice(0, 2000),
        }));
      }

      if (finalMessages.length === 0 && prompt) {
        finalMessages = [
          {
            role: 'user',
            content: String(prompt).slice(0, 2000),
          },
        ];
      }

      if (finalMessages.length === 0) {
        return reply.status(400).send({
          error: 'Prompt or valid messages are required',
        });
      }

      const MAX_MESSAGES = 32;
      const MAX_MESSAGE_CHARS = 4000;
      const MAX_TOTAL_CHARS = 32000;
      if (finalMessages.length > MAX_MESSAGES) {
        return reply.status(413).send({
          error: 'Too many messages',
        });
      }

      let totalChars = 0;

      for (const msg of finalMessages) {
        const content = String(msg.content || '');

        if (content.length > MAX_MESSAGE_CHARS) {
          return reply.status(413).send({
            error: 'Message exceeds maximum length',
          });
        }

        totalChars += content.length;
      }

      if (totalChars > MAX_TOTAL_CHARS) {
        return reply.status(413).send({
          error: 'Prompt too long',
        });
      }

      if (finalMessages.some((msg) => !msg.content || !msg.content.trim())) {
        return reply.status(400).send({
          error: 'Message content cannot be empty',
        });
      }

      try {
        const usageResult = await aiRepo.tryIncrementUsage(
          req.user.id,
          config.ai.dailyLimit
        );

        if (!usageResult) {
          return reply.status(429).send({
            error: 'Daily AI usage limit exceeded',
          });
        }

        const result = await generateAIResponse({
          userId: req.user.id,
          messages: finalMessages,
        });

        return {
          provider: result.provider,
          cached: result.cached,
          content: result.content,
        };
      } catch (error) {
        if (error.statusCode === 413) {
          return reply.status(413).send({
            error: 'AI provider response too large',
          });
        }

        // `error.details` (when present) is the per-provider failure list
        // produced by generateAIResponse — e.g. [{ provider: 'gemini',
        // reason: 'missing_api_key' }, ...]. It's the actually useful
        // diagnostic signal (which providers were tried and why each one
        // failed) so it must be logged alongside the top-level error
        // message, not dropped. None of this is sent to the client.
        req.log.error(
          {
            err: error.message,
            code: error.statusCode,
            providers: error.details,
          },
          'AI provider failed'
        );
        return reply.status(503).send({
          error: 'AI service unavailable',
        });
      }
    }
  );

  const imageBodySchema = z.object({
    prompt: z.string().min(1).max(2000),
  });

  fastify.post(
    '/generate-image',
    {
      schema: {
        tags: ['AI'],
        description: 'Generate an image from an assignment topic description',
        body: toSchema(imageBodySchema),
      },
      preHandler: [auth, rbac('ADMIN', 'SENIOR_TL', 'TL'), sanitize],
      config: {
        rateLimit: {
          max: AI_CHAT_RATE_LIMIT,
          timeWindow: '1 minute',
          keyGenerator: (req) => req.user?.id || req.ip,
        },
      },
    },
    async (req, reply) => {
      const { prompt } = req.body || {};

      if (!prompt || !prompt.trim()) {
        return reply.status(400).send({
          error: 'Prompt is required',
        });
      }

      try {
        const usageResult = await aiRepo.tryIncrementUsage(
          req.user.id,
          config.ai.dailyLimit
        );

        if (!usageResult) {
          return reply.status(429).send({
            error: 'Daily AI usage limit exceeded',
          });
        }

        const result = await generateAIImage({ prompt: prompt.trim() });

        const fs = require('fs');
        const path = require('path');
        const crypto = require('crypto');
        const config = require('../../config');

        const buffer = Buffer.from(result.image_base64, 'base64');
        const fileName = `task_${req.user.id}_${crypto.randomBytes(6).toString('hex')}.png`;
        const uploadPath = path.join(
          __dirname,
          '..',
          '..',
          '..',
          config.uploadDir
        );
        fs.mkdirSync(uploadPath, { recursive: true });
        fs.writeFileSync(path.join(uploadPath, fileName), buffer);

        const imageUrl = `/uploads/${fileName}`;

        return {
          provider: result.provider,
          image_base64: result.image_base64,
          image_path: imageUrl,
        };
      } catch (error) {
        if (error.statusCode === 429) {
          return reply.status(429).send({
            error: 'AI provider rate limit exceeded',
          });
        }
        if (error.statusCode === 413) {
          return reply.status(413).send({
            error: 'AI provider response too large',
          });
        }

        req.log.error(
          { err: error.message, code: error.statusCode },
          'AI image generation failed'
        );
        return reply.status(503).send({
          error: 'Image generation service unavailable',
        });
      }
    }
  );

  fastify.get(
    '/health',
    {
      preHandler: [auth, rbac('ADMIN')],
      schema: { tags: ['AI'], description: 'Check AI provider health' },
    },
    async () => {
      const providers = getProviderHealth().map((provider) => ({
        name: provider.name,
        status: provider.available ? 'healthy' : 'unhealthy',
        lastErrorMessage: provider.lastError?.message || null,
      }));

      return {
        providers,
      };
    }
  );

  fastify.get(
    '/usage',
    {
      preHandler: [auth, rbac('ADMIN')],
      schema: { tags: ['AI'], description: 'Get AI usage report' },
    },
    async () => {
      const usage = await aiRepo.getDailyUsageReport();

      return {
        date: new Date().toISOString().split('T')[0],
        users: usage,
      };
    }
  );
}

module.exports = routes;

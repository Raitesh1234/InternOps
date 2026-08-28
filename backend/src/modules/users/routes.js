const {
  sanitizationMiddleware: sanitize,
} = require('../../middleware/sanitize');
const auth = require('../../middleware/auth');
const rbac = require('../../middleware/rbac');
const ownership = require('../../middleware/ownership');
const repo = require('./repository');
const argon2 = require('argon2');
const { z } = require('zod');
const authRepo = require('../auth/repository');
const { toSchema } = require('../../utils/schemaHelper');
const { isValidStep } = require('../../utils/hierarchy');

const listUsersQuerySchema = z.object({
  search: z.string().trim().max(100).optional(),
  role: z.enum(['ADMIN', 'SENIOR_TL', 'TL', 'CAPTAIN', 'INTERN']).optional(),
  suspended: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  sortBy: z
    .enum(['name', 'created_at', 'last_login'])
    .optional()
    .default('created_at'),
  sortOrder: z
    .enum(['asc', 'desc'])
    .optional()
    .default('asc'),
});

const USER_ROLES = [
  'ADMIN',
  'MANAGEMENT',
  'HR',
  'SENIOR_TL',
  'TL',
  'CAPTAIN',
  'INTERN',
];

const updateUserSchema = z
  .object({
    full_name: z.string().trim().min(1).max(255).optional(),
    email: z.string().trim().email().max(255).optional(),
    role: z.enum(USER_ROLES).optional(),
    department_id: z.string().uuid().nullable().optional(),
    manager_id: z.string().uuid().nullable().optional(),
  })
  .strict()
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one editable field is required',
  });

const allowedAvatarExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];

const isValidAvatarUrl = (val) => {
  if (typeof val !== 'string') return false;
  if (val.startsWith('/uploads/')) return true;

  try {
    const url = new URL(val);

    if (!['http:', 'https:'].includes(url.protocol)) return false;

    const pathname = url.pathname.toLowerCase();
    return allowedAvatarExtensions.some((ext) => pathname.endsWith(ext));
  } catch {
    return false;
  }
};

const changePasswordSchema = z.object({
  oldPassword: z.string(),
  newPassword: z.string().min(8),
});

const updateProfileSchema = z.object({
  full_name: z.string().optional(),
  phone: z.string().optional(),
  college: z.string().optional(),
  course: z.string().optional(),
  year_of_study: z.string().optional(),
  position: z.string().optional(),
  joining_date: z.string().optional(),
  internship_status: z.string().optional(),
  location: z.string().optional(),
  notes: z.string().optional(),
  avatar_url: z
    .string()
    .url()
    .regex(/^https?:\/\/.+\.(jpg|jpeg|png|gif|webp)$/i)
    .optional(),
});

async function routes(fastify) {
  // Admin: list users (paginated, searchable, sortable with total count)
  fastify.get(
    '/users',
    {
      schema: {
        querystring: toSchema(listUsersQuerySchema, 'querystring'),
      },
      preHandler: [auth, rbac(['ADMIN', 'SENIOR_TL', 'TL'])],
    },
    async (request, reply) => {
      try {
        const query = listUsersQuerySchema.parse(request.query);
        const result = await repo.findPaginated(query);
        return reply.send(result);
      } catch (error) {
        request.log.error(error);
        return reply.status(500).send({
          error: 'Failed to fetch users',
          message: error.message,
        });
      }
    }
  );

  // GET /users/:id - Get single user
  fastify.get(
    '/users/:id',
    {
      preHandler: [auth],
    },
    async (request, reply) => {
      try {
        const { id } = request.params;
        const result = await repo.findById(id);
        if (!result) {
          return reply.status(404).send({ error: 'User not found' });
        }
        return reply.send(result);
      } catch (error) {
        request.log.error(error);
        return reply.status(500).send({ error: 'Failed to fetch user' });
      }
    }
  );

  // Update user (admin only)
  fastify.patch(
    '/:id',
    {
      preHandler: [auth, rbac('ADMIN'), sanitize],
      schema: {
        tags: ['Users'],
        description: 'Update user (Admin only)',
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
        body: {
          type: 'object',
          minProperties: 1,
          additionalProperties: false,
          properties: {
            full_name: { type: 'string', minLength: 1, maxLength: 255 },
            email: { type: 'string', format: 'email', maxLength: 255 },
            role: { type: 'string', enum: USER_ROLES },
            department_id: {
              anyOf: [{ type: 'string', format: 'uuid' }, { type: 'null' }],
            },
            manager_id: {
              anyOf: [{ type: 'string', format: 'uuid' }, { type: 'null' }],
            },
          },
        },
      },
    },
    async (req, reply) => {
      const parsed = updateUserSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'Invalid user update',
          details: parsed.error.issues,
        });
      }

      const {
        rows: [targetUser],
      } = await repo.getUserById(req.params.id);

      if (!targetUser) {
        return reply.status(404).send({ error: 'User not found' });
      }

      const data = { ...parsed.data };
      if (data.email !== undefined) data.email = data.email.toLowerCase();

      const nextRole = data.role || targetUser.role;

      if (
        targetUser.role === 'ADMIN' &&
        !targetUser.suspended &&
        nextRole !== 'ADMIN'
      ) {
        const otherAdminCount = await repo.countOtherActiveAdmins(
          req.params.id
        );
        if (otherAdminCount === 0) {
          return reply.status(400).send({
            error: 'Cannot demote the last active admin',
          });
        }
      }

      if (data.department_id) {
        const department = await repo.getDepartmentById(data.department_id);
        if (!department) {
          return reply.status(400).send({ error: 'Department not found' });
        }
      }

      if (data.manager_id !== undefined && data.manager_id !== null) {
        if (data.manager_id === req.params.id) {
          return reply.status(400).send({
            error: 'A user cannot manage their own account',
          });
        }

        const {
          rows: [manager],
        } = await repo.getUserById(data.manager_id);

        if (!manager) {
          return reply.status(400).send({ error: 'Manager not found' });
        }

        if (!isValidStep(manager.role, nextRole)) {
          return reply.status(400).send({
            error: `Invalid hierarchy: ${manager.role} cannot manage ${nextRole}`,
          });
        }
      } else if (data.role !== undefined && targetUser.manager_id) {
        const {
          rows: [manager],
        } = await repo.getUserById(targetUser.manager_id);

        if (manager && !isValidStep(manager.role, nextRole)) {
          return reply.status(400).send({
            error: 'Select a valid manager when changing this user role',
          });
        }
      }

      try {
        const updatedUser = await repo.updateUser(req.params.id, data);

        req.auditOnResponse = {
          userId: req.user.id,
          action: 'USER_UPDATED',
          resourceType: 'user',
          resourceId: req.params.id,
          details: { fields: Object.keys(data) },
        };

        return { message: 'User updated', user: updatedUser };
      } catch (error) {
        if (error.code === '23505') {
          return reply.status(409).send({
            error: 'A user with this email already exists',
          });
        }
        throw error;
      }
    }
  );

  // Update user (admin only)
  fastify.patch(
    '/:id',
    {
      preHandler: [auth, rbac('ADMIN'), sanitize],
      schema: {
        tags: ['Users'],
        description: 'Update user (Admin only)',
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
        body: {
          type: 'object',
          minProperties: 1,
          additionalProperties: false,
          properties: {
            full_name: { type: 'string', minLength: 1, maxLength: 255 },
            email: { type: 'string', format: 'email', maxLength: 255 },
            role: { type: 'string', enum: USER_ROLES },
            department_id: {
              anyOf: [{ type: 'string', format: 'uuid' }, { type: 'null' }],
            },
            manager_id: {
              anyOf: [{ type: 'string', format: 'uuid' }, { type: 'null' }],
            },
          },
        },
      },
    },
    async (req, reply) => {
      const parsed = updateUserSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'Invalid user update',
          details: parsed.error.issues,
        });
      }

      const {
        rows: [targetUser],
      } = await repo.getUserById(req.params.id);

      if (!targetUser) {
        return reply.status(404).send({ error: 'User not found' });
      }

      const data = { ...parsed.data };
      if (data.email !== undefined) data.email = data.email.toLowerCase();

      const nextRole = data.role || targetUser.role;

      if (
        targetUser.role === 'ADMIN' &&
        !targetUser.suspended &&
        nextRole !== 'ADMIN'
      ) {
        const otherAdminCount = await repo.countOtherActiveAdmins(
          req.params.id
        );
        if (otherAdminCount === 0) {
          return reply.status(400).send({
            error: 'Cannot demote the last active admin',
          });
        }
        return reply.status(500).send({ error: 'Failed to create user' });
      }
    }
  );

  // PUT /users/:id - Update user
  fastify.put(
    '/users/:id',
    {
      preHandler: [auth, ownership, sanitize],
    },
    async (request, reply) => {
      try {
        const { id } = request.params;
        const updates = request.body;
        const result = await repo.update(id, updates);
        if (!result) {
          return reply.status(404).send({ error: 'User not found' });
        }
        return reply.send(result);
      } catch (error) {
        request.log.error(error);
        return reply.status(500).send({ error: 'Failed to update user' });
      }
    }
  );

  // DELETE /users/:id - Delete user
  fastify.delete(
    '/:id',
    {
      preHandler: [auth, rbac('ADMIN')],
      schema: {
        tags: ['Users'],
        description: 'Soft-delete user (Admin only)',
        params: { type: 'object', properties: { id: { type: 'string' } } },
      },
    },
    async (req, reply) => {
      // Prevent self-deletion
      if (req.user.id === req.params.id) {
        return reply.status(400).send({
          error: 'You cannot delete your own account',
        });
      }

        const {
          rows: [manager],
        } = await repo.getUserById(data.manager_id);

        if (!manager) {
          return reply.status(400).send({ error: 'Manager not found' });
        }

        if (!isValidStep(manager.role, nextRole)) {
          return reply.status(400).send({
            error: `Invalid hierarchy: ${manager.role} cannot manage ${nextRole}`,
          });
        }
      } else if (data.role !== undefined && targetUser.manager_id) {
        const {
          rows: [manager],
        } = await repo.getUserById(targetUser.manager_id);

        if (manager && !isValidStep(manager.role, nextRole)) {
          return reply.status(400).send({
            error: 'Select a valid manager when changing this user role',
          });
        }
      }

      try {
        const updatedUser = await repo.updateUser(req.params.id, data);

        req.auditOnResponse = {
          userId: req.user.id,
          action: 'USER_UPDATED',
          resourceType: 'user',
          resourceId: req.params.id,
          details: { fields: Object.keys(data) },
        };

        return { message: 'User updated', user: updatedUser };
      } catch (error) {
        if (error.code === '23505') {
          return reply.status(409).send({
            error: 'A user with this email already exists',
          });
        }
        throw error;
      }
    }
  );

  // POST /users - Create user
  fastify.post(
    '/users',
    {
      preHandler: [auth, rbac(['ADMIN']), sanitize],
    },
    async (request, reply) => {
      try {
        const userData = request.body;
        const result = await repo.create(userData);
        return reply.status(201).send(result);
      } catch (error) {
        request.log.error(error);
        if (error.code === '23505') {
          return reply
            .status(409)
            .send({ error: 'User with this email already exists' });
        }
        return reply.status(500).send({ error: 'Failed to create user' });
      }
    }
  );

  // PUT /users/:id - Update user
  fastify.put(
    '/users/:id',
    {
      preHandler: [auth, ownership, sanitize],
    },
    async (request, reply) => {
      try {
        const { id } = request.params;
        const updates = request.body;
        const result = await repo.update(id, updates);
        if (!result) {
          return reply.status(404).send({ error: 'User not found' });
        }
        return reply.send(result);
      } catch (error) {
        request.log.error(error);
        return reply.status(500).send({ error: 'Failed to update user' });
      }
    }
  );

  // DELETE /users/:id - Delete user
  fastify.delete(
    '/users/:id',
    {
      preHandler: [auth, rbac(['ADMIN'])],
    },
    async (request, reply) => {
      try {
        const { id } = request.params;
        const result = await repo.delete(id);
        if (!result) {
          return reply.status(404).send({ error: 'User not found' });
        }
        return reply.status(204).send();
      } catch (error) {
        request.log.error(error);
        return reply.status(500).send({ error: 'Failed to delete user' });
      }
    }
  );
}

module.exports = routes;

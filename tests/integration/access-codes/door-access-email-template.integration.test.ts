import express from "express";
import request from "supertest";
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import {
  beforeAll,
  beforeEach,
  afterAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// Authentication is supplied by the harness; real permission/location middleware
// and the actual API controller/service/database are exercised below.
vi.mock("@/modules/auth/middleware/verifyJWT.js", () => ({
  verifyJWT: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
import Location from "@/modules/location/location.model.js";
import { locationRepository } from "@/modules/location/location.repository.js";
import { updateLocationSchema } from "@/modules/location/location.validators.js";
import router from "@/modules/email-template/email-template.routes.js";
import { WORKSPACE_PERMISSION as P } from "@/modules/tenant-access/tenant-access.permissions.js";
import {
  listDoorAccessEmailTemplates,
  resetDoorAccessEmailTemplate,
  resolveDoorAccessEmailTemplate,
  saveDoorAccessEmailTemplate,
} from "@/modules/access-codes/services/door-access-email-template.service.js";

const tenant = new Types.ObjectId(),
  otherTenant = new Types.ObjectId();
const location = new Types.ObjectId(),
  secondLocation = new Types.ObjectId(),
  foreignLocation = new Types.ObjectId(),
  archivedLocation = new Types.ObjectId();
const template = {
  defaultLocale: "en",
  contentVariants: {
    en: {
      subject: "Welcome to {{studioName}}",
      format: "plain",
      body: "Location-specific arrival instructions. Your code: {{entryCode}}\n{{bookingTime}}",
    },
  },
};
let mongo: MongoMemoryServer;
let permissions: string[];
let allowedLocations: string[] | null;
let context: string;
const app = express();
app.use(express.json());
app.use((req: any, _res, next) => {
  req.userInfo = { authContext: context, tenantId: String(tenant) };
  req.workspaceAccessResolved = true;
  req.workspaceAccess = {
    status: "active",
    permissions,
    locationAccess: {
      mode: allowedLocations ? "selected" : "all",
      locationIds: allowedLocations || [],
    },
  };
  next();
});
app.use("/email-templates", router);
app.use((error: any, _req: any, res: any, _next: any) => {
  res
    .status(error.statusCode || (error.name === "ZodError" ? 400 : 500))
    .json({ code: error.code, message: error.message });
});

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri(), {
    autoIndex: false,
    autoCreate: false,
  });
}, 120_000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});
beforeEach(async () => {
  await Location.deleteMany({});
  permissions = [
    P.COMMUNICATIONS_VIEW,
    P.COMMUNICATIONS_MANAGE,
    P.ACCESS_CODES_VIEW,
    P.ACCESS_CODES_MANAGE,
  ];
  allowedLocations = null;
  context = "workspace";
  await Location.collection.insertMany([
    {
      _id: location,
      tenant,
      name: "North studio",
      isActive: true,
      access: {
        automaticEmailEnabled: true,
        doorCode: "never-return-this-code",
        privateInstructions: "private arrival note",
      },
      booking: { doorCodeMinutesBefore: 15 },
    },
    { _id: secondLocation, tenant, name: "South studio", isActive: true },
    {
      _id: foreignLocation,
      tenant: otherTenant,
      name: "Other workspace",
      isActive: true,
    },
    { _id: archivedLocation, tenant, name: "Closed location", isActive: false },
  ] as any);
});

describe("scoped door-email template persistence and API", () => {
  it("lists virtual defaults without secrets or unnecessary writes", async () => {
    const response = await request(app)
      .get("/email-templates/door-access")
      .expect(200);
    expect(response.body.locations).toHaveLength(2);
    expect(response.body.locations[0]).toMatchObject({
      locationId: String(location),
      locationName: "North studio",
      isCustomized: false,
    });
    expect(
      response.body.locations[0].template.contentVariants.cs.htmlContent,
    ).toContain("{{entryCode}}");
    expect(JSON.stringify(response.body)).not.toMatch(
      /never-return-this-code|private arrival note|Other workspace|Closed location/,
    );
    expect(
      await Location.collection.findOne({ _id: location }),
    ).not.toHaveProperty("access.emailTemplate");
  });

  it("saves, reloads and resets just the selected location without changing email enablement or timing", async () => {
    const saved = await request(app)
      .patch(`/email-templates/door-access/${location}`)
      .send(template)
      .expect(200);
    expect(saved.body.location).toMatchObject({
      locationId: String(location),
      isCustomized: true,
      template,
    });
    const listed = await listDoorAccessEmailTemplates(String(tenant));
    expect(
      listed.locations.find((row) => row.locationId === String(location))
        ?.isCustomized,
    ).toBe(true);
    expect(
      await resolveDoorAccessEmailTemplate(String(tenant), String(location)),
    ).toMatchObject(template);
    expect(
      await resolveDoorAccessEmailTemplate(
        String(tenant),
        String(secondLocation),
      ),
    ).toBeNull();
    expect(
      await resolveDoorAccessEmailTemplate(
        String(otherTenant),
        String(location),
      ),
    ).toBeNull();
    const reset = await request(app)
      .delete(`/email-templates/door-access/${location}`)
      .expect(200);
    expect(reset.body.location.isCustomized).toBe(false);
    expect(
      reset.body.location.template.contentVariants.en.htmlContent,
    ).toContain("{{entryCode}}");
    const stored = await Location.collection.findOne({ _id: location });
    expect(stored).toMatchObject({
      access: { automaticEmailEnabled: true },
      booking: { doorCodeMinutesBefore: 15 },
    });
    expect(stored?.access?.emailTemplate).toBeUndefined();
  });

  it("does not expose custom copy through ordinary location reads or overwrite it through general location edits", async () => {
    await saveDoorAccessEmailTemplate(
      String(tenant),
      String(location),
      template,
    );
    const ordinary = await locationRepository.findByIdForTenant(
      String(tenant),
      String(location),
      { includePrivateAccess: true },
    );
    expect(ordinary?.toObject().access.emailTemplate).toBeUndefined();
    const input = updateLocationSchema.parse({
      id: String(location),
      access: {
        publicInstructions: "New public note",
        emailTemplate: { malicious: true },
      },
    });
    await locationRepository.update(String(tenant), input);
    expect(
      await resolveDoorAccessEmailTemplate(String(tenant), String(location)),
    ).toMatchObject(template);
    expect(
      (await Location.collection.findOne({ _id: location }))?.access
        ?.publicInstructions,
    ).toBe("New public note");
  });

  it("enforces tenant and selected-location scope for listing, saving and resetting", async () => {
    allowedLocations = [String(location)];
    expect(
      (await request(app).get("/email-templates/door-access").expect(200)).body
        .locations,
    ).toHaveLength(1);
    for (const id of [secondLocation, foreignLocation, archivedLocation]) {
      await request(app)
        .patch(`/email-templates/door-access/${id}`)
        .send(template)
        .expect(404);
      await request(app)
        .delete(`/email-templates/door-access/${id}`)
        .expect(404);
    }
    allowedLocations = [];
    expect(
      (await request(app).get("/email-templates/door-access").expect(200)).body
        .locations,
    ).toEqual([]);
    allowedLocations = null;
    for (const id of [foreignLocation, archivedLocation]) {
      await expect(
        saveDoorAccessEmailTemplate(String(tenant), String(id), template),
      ).rejects.toMatchObject({ statusCode: 404 });
      await expect(
        resetDoorAccessEmailTemplate(String(tenant), String(id)),
      ).rejects.toMatchObject({ statusCode: 404 });
    }
  });

  it("requires both communications and access-code permissions and denies customer sessions", async () => {
    for (const required of [P.COMMUNICATIONS_VIEW, P.ACCESS_CODES_VIEW]) {
      permissions = [P.COMMUNICATIONS_VIEW, P.ACCESS_CODES_VIEW].filter(
        (p) => p !== required,
      );
      await request(app).get("/email-templates/door-access").expect(403);
    }
    for (const required of [P.COMMUNICATIONS_MANAGE, P.ACCESS_CODES_MANAGE]) {
      permissions = [P.COMMUNICATIONS_MANAGE, P.ACCESS_CODES_MANAGE].filter(
        (p) => p !== required,
      );
      await request(app)
        .patch(`/email-templates/door-access/${location}`)
        .send(template)
        .expect(403);
      await request(app)
        .delete(`/email-templates/door-access/${location}`)
        .expect(403);
    }
    permissions = [
      P.COMMUNICATIONS_VIEW,
      P.COMMUNICATIONS_MANAGE,
      P.ACCESS_CODES_VIEW,
      P.ACCESS_CODES_MANAGE,
    ];
    context = "customer";
    await request(app).get("/email-templates/door-access").expect(403);
    await request(app)
      .patch(`/email-templates/door-access/${location}`)
      .send(template)
      .expect(403);
  });

  it("rejects incomplete copy and invalid location ids without persisting anything", async () => {
    await request(app)
      .patch(`/email-templates/door-access/${location}`)
      .send({
        defaultLocale: "en",
        contentVariants: {
          en: { subject: "No code", format: "plain", body: "No code here" },
        },
      })
      .expect(400);
    await request(app)
      .patch("/email-templates/door-access/not-an-id")
      .send(template)
      .expect(400);
    expect(
      await resolveDoorAccessEmailTemplate(String(tenant), String(location)),
    ).toBeNull();
  });

  it("falls back to the system message for invalid historical overrides", async () => {
    await Location.collection.updateOne(
      { _id: location },
      {
        $set: {
          "access.emailTemplate": {
            defaultLocale: "en",
            contentVariants: {
              en: { subject: "Bad", format: "plain", body: "No code" },
            },
          },
        },
      },
    );
    expect(
      await resolveDoorAccessEmailTemplate(String(tenant), String(location)),
    ).toBeNull();
  });
});

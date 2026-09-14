import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "node:crypto";
import { PlatformError, type Data } from "./client.js";
import type { RegisteredHandler, Context } from "./server.js";
export interface R2Options {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  privateBucket: string;
  publicBucket?: string;
  publicBaseUrl?: string;
  maxUploadBytes?: number;
}
export class R2Storage {
  readonly client: S3Client;
  constructor(readonly options: R2Options) {
    if (options.privateBucket === options.publicBucket)
      throw new Error("Public and private buckets must be different");
    this.client = new S3Client({
      region: "auto",
      endpoint: `https://${options.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
      },
    });
  }
  async upload(
    file: Blob,
    scope: { appId: string; userId: string },
    isPublic = false,
  ) {
    if (
      !(file instanceof Blob) ||
      file.size > (this.options.maxUploadBytes ?? 10 * 1024 * 1024)
    )
      throw new PlatformError("Invalid or oversized file", 400);
    if (
      isPublic &&
      (!this.options.publicBucket ||
        !this.options.publicBaseUrl?.startsWith("https://"))
    )
      throw new PlatformError(
        "Public R2 bucket and HTTPS custom domain required",
        501,
      );
    const key = `${encodeURIComponent(scope.appId)}/${encodeURIComponent(scope.userId)}/${randomUUID()}`;
    await this.client.send(
      new PutObjectCommand({
        Bucket: isPublic
          ? this.options.publicBucket
          : this.options.privateBucket,
        Key: key,
        Body: new Uint8Array(await file.arrayBuffer()),
        ContentType: file.type || "application/octet-stream",
        ContentDisposition: "attachment",
      }),
    );
    return isPublic
      ? { file_url: `${this.options.publicBaseUrl!.replace(/\/$/, "")}/${key}` }
      : { file_uri: key };
  }
  async signedUrl(file_uri: string, expires_in = 300) {
    if (!Number.isInteger(expires_in) || expires_in < 1 || expires_in > 3600)
      throw new PlatformError("Expiry must be 1-3600 seconds", 400);
    return {
      signed_url: await getSignedUrl(
        this.client,
        new GetObjectCommand({
          Bucket: this.options.privateBucket,
          Key: file_uri,
        }),
        { expiresIn: expires_in },
      ),
    };
  }
  async deletePrivate(file_uri: string) {
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.options.privateBucket,
        Key: file_uri,
      }),
    );
  }
  /** Install these behind application policy; private URLs are bound to uploader by default. */
  integrations(): Record<string, RegisteredHandler> {
    const user = (context: Context) => {
      if (!context.user && !context.service)
        throw new PlatformError("Unauthorized", 401);
      return { appId: context.appId, userId: context.user?.id ?? "service" };
    };
    const upload = (isPublic: boolean): RegisteredHandler => ({
      authorize: (s) => !!s.user,
      run: (d, c) => this.upload(d.file, user(c), isPublic),
    });
    return {
      UploadFile: upload(true),
      UploadPublicFile: upload(true),
      UploadPrivateFile: upload(false),
      CreateFileSignedUrl: {
        authorize: (s, d) =>
          !!s.user &&
          typeof d.file_uri === "string" &&
          d.file_uri.startsWith(
            `${encodeURIComponent(s.appId)}/${encodeURIComponent(s.user.id)}/`,
          ),
        run: (d) => this.signedUrl(d.file_uri, d.expires_in),
      },
    };
  }
}
/** Server-only DNS control. No implicit zone selection and no changes during setup. */
export class CloudflareDNS {
  constructor(
    private token: string,
    readonly zoneId: string,
    private transport: typeof fetch = fetch,
  ) {
    if (!/^[a-f0-9]{32}$/i.test(zoneId))
      throw new Error("Explicit Cloudflare zoneId required");
  }
  private async request(path: string, method = "GET", data?: Data) {
    const response = await this.transport(
      `https://api.cloudflare.com/client/v4/zones/${this.zoneId}/dns_records${path}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        body: data ? JSON.stringify(data) : undefined,
      },
    );
    const body = (await response.json()) as Data;
    if (!response.ok || !body.success)
      throw new PlatformError(
        "Cloudflare DNS request failed",
        response.status >= 400 ? response.status : 502,
      );
    return body;
  }
  async list(
    params: {
      name?: string;
      type?: string;
      page?: number;
      per_page?: number;
    } = {},
  ) {
    const q = new URLSearchParams(
      Object.entries(params).map(([k, v]) => [k, String(v)]),
    );
    return this.request("?" + q);
  }
  async create(record: Data) {
    return (await this.request("", "POST", record)).result;
  }
  async update(id: string, patch: Data) {
    if (!/^[a-f0-9]{32}$/i.test(id)) throw new Error("Invalid record ID");
    return (await this.request("/" + id, "PATCH", patch)).result;
  }
  async delete(id: string) {
    if (!/^[a-f0-9]{32}$/i.test(id)) throw new Error("Invalid record ID");
    return (await this.request("/" + id, "DELETE")).result;
  }
}

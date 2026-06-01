/**
 * gRPC + Protobuf helpers for MCP Conversation Engine backend.
 *
 * Thin wrappers around @grpc/grpc-js and @bufbuild/protobuf so that
 * agent-created dynamic services can reuse them without boilerplate.
 */

import * as grpc from "@grpc/grpc-js";
import { create, fromJson, toJson, type JsonValue, type Message, type DescMessage } from "@bufbuild/protobuf";

export { grpc, create, fromJson, toJson };
export type { JsonValue, Message, DescMessage };

/**
 * Create a gRPC client channel (credentials default to insecure for local dev).
 */
export function createChannel(
  address: string,
  credentials?: grpc.ChannelCredentials
): grpc.Channel {
  const creds = credentials ?? grpc.credentials.createInsecure();
  return new grpc.Channel(address, creds, {});
}

/**
 * Promisify a unary gRPC client call.
 *
 * Note: this is a low-level helper. Most users should prefer generated gRPC
 * stubs, but this works when you only have @grpc/grpc-js primitives.
 */
export function callUnary<Request, Response>(
  client: grpc.Client,
  path: string,
  request: Request,
  responseDeserialize: (bytes: Buffer) => Response,
  requestSerialize?: (value: Request) => Buffer,
  metadata?: grpc.Metadata
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const deadline = new Date(Date.now() + 30000);
    const serialize = requestSerialize ?? ((arg: Request) => arg as unknown as Buffer);

    client.makeUnaryRequest(
      path,
      serialize,
      responseDeserialize,
      request,
      metadata ?? new grpc.Metadata(),
      { deadline },
      (err: grpc.ServiceError | null, response?: Response) => {
        if (err) reject(err);
        else if (response === undefined) reject(new Error("Empty response"));
        else resolve(response);
      }
    );
  });
}

/**
 * Create a basic gRPC service definition for dynamic services.
 * Suitable for agent-generated scripts that don't have protoc-generated code.
 */
export function buildServiceDefinition(
  methods: Record<
    string,
    {
      requestStream?: boolean;
      responseStream?: boolean;
    }
  >
): grpc.ServiceDefinition {
  const def = {} as Record<string, grpc.MethodDefinition<any, any>>;
  for (const [name, cfg] of Object.entries(methods)) {
    def[name] = {
      path: `/dynamic/${name}`,
      requestStream: cfg.requestStream ?? false,
      responseStream: cfg.responseStream ?? false,
      requestSerialize: (value: Buffer) => value,
      requestDeserialize: (bytes: Buffer) => bytes,
      responseSerialize: (value: Buffer) => value,
      responseDeserialize: (bytes: Buffer) => bytes,
    };
  }
  return def as grpc.ServiceDefinition;
}

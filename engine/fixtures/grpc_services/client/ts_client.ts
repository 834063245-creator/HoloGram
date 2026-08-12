// grpc-js 风格客户端
import { GreeterClient } from "./greeter_grpc_pb";
import { HelloRequest } from "./greeter_pb";

const client = new GreeterClient("localhost:50051");

export function greet(name: string): void {
  const req = new HelloRequest();
  req.setName(name);
  client.sayHello(req, (err: Error | null, reply) => {
    if (err) {
      console.error(err);
      return;
    }
    console.log(reply.getMessage());
  });
}

# grpcio 风格客户端
import grpc
import greeter_pb2
import greeter_pb2_grpc


def greet(name: str) -> str:
    channel = grpc.insecure_channel("localhost:50051")
    stub = greeter_pb2_grpc.GreeterStub(channel)
    resp = stub.SayHello(greeter_pb2.HelloRequest(name=name))
    return resp.message

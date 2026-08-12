// grpc-java 风格客户端：链式调用 + 变量式两种形态
package com.example.client;

import io.grpc.ManagedChannel;
import io.grpc.ManagedChannelBuilder;

public class GreeterClient {
    public void greet(String name) {
        ManagedChannel channel =
                ManagedChannelBuilder.forAddress("localhost", 50051).usePlaintext().build();

        // 链式调用（无中间变量）
        String reply = GreeterGrpc.newBlockingStub(channel).sayHello(
                HelloRequest.newBuilder().setName(name).build()).getMessage();

        // 变量式
        GreeterBlockingStub stub = GreeterGrpc.newBlockingStub(channel);
        HelloReply resp = stub.sayHello(HelloRequest.newBuilder().setName(name).build());
        System.out.println(resp.getMessage());
    }
}

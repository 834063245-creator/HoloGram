package main

import (
	"context"
	"log"

	"google.golang.org/grpc"
	pb "helloworld/v1"
)

func main() {
	conn, err := grpc.NewClient("localhost:50051")
	if err != nil {
		log.Fatal(err)
	}
	client := NewGreeterClient(conn)
	resp, err := client.SayHello(context.Background(), &pb.HelloRequest{Name: "world"})
	if err != nil {
		log.Fatal(err)
	}
	log.Println(resp.GetMessage())
}

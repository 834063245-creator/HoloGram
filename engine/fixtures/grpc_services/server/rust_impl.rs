// tonic 风格服务端实现（模拟生成代码的 impl 块）
pub struct GreeterService;

#[tonic::async_trait]
impl greeter_server::Greeter for GreeterService {
    async fn say_hello(
        &self,
        request: Request<HelloRequest>,
    ) -> Result<Response<HelloReply>, Status> {
        let name = request.into_inner().name;
        Ok(Response::new(HelloReply {
            message: format!("Hello, {name}!"),
        }))
    }

    async fn send_email(
        &self,
        request: Request<EmailRequest>,
    ) -> Result<Response<EmailReply>, Status> {
        let to = request.into_inner().to;
        Ok(Response::new(EmailReply { sent: !to.is_empty() }))
    }
}

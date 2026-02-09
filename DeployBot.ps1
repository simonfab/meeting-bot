aws ecr get-login-password --region eu-west-1 | docker login --username AWS --password-stdin 391202570628.dkr.ecr.eu-west-1.amazonaws.com
docker build --pull --rm -f 'Dockerfile.production' -t 'meeting-bot:latest' '.'
docker tag meeting-bot:latest 391202570628.dkr.ecr.eu-west-1.amazonaws.com/meeting-bot:latest
docker push 391202570628.dkr.ecr.eu-west-1.amazonaws.com/meeting-bot:latest
$env:AWS_PAGER = ""
aws ecs update-service --no-cli-pager --cluster helloworld3-cluster --service meeting-bot-task-service-venno6jl  --force-new-deployment | Out-Null


using System.Text.Json.Nodes;
using Chain.Workflows.Definitions;
using Chain.Workflows.Runtime;
using Chain.Workflows.Tests.Definitions;

namespace Chain.Workflows.Tests.Runtime;

/// <summary>Token movement rules (workflow-engine.md §3) on the sample credit workflow.</summary>
public sealed class NavigatorTests
{
    private static FlowNavigator Navigator(JsonObject? document = null)
    {
        var parsed = WorkflowDocumentParser.Parse((document ?? SampleWorkflow.Create()).ToJsonString());
        return new FlowNavigator(parsed.Document!);
    }

    [Fact]
    public void Start_moves_to_the_first_wait_state()
    {
        var arrival = Navigator().Start();

        var wait = Assert.IsType<Arrival.Wait>(arrival);
        Assert.Equal("task_1", wait.Node.Id);
        Assert.Equal(TaskKindAtNode.Task, wait.Kind);
        Assert.Equal(Guid.Parse(SampleWorkflow.AnalystGroupId), wait.GroupId);
    }

    [Fact]
    public void Human_gateway_is_a_decision_wait_state()
    {
        var wait = Assert.IsType<Arrival.Wait>(Navigator().After("task_1"));

        Assert.Equal("gw_1", wait.Node.Id);
        Assert.Equal(TaskKindAtNode.Decision, wait.Kind);
    }

    [Fact]
    public void Decision_outcome_selects_the_branch()
    {
        var navigator = Navigator();

        Assert.IsType<Arrival.Finished>(navigator.After("gw_1", Branch.True));
        Assert.Equal("task_1", Assert.IsType<Arrival.Wait>(navigator.After("gw_1", Branch.False)).Node.Id);
    }

    [Fact]
    public void Requesters_lane_and_nodes_without_lane_have_no_group()
    {
        var document = SampleWorkflow.Create();
        SampleWorkflow.Node(document, "task_1")["laneId"] = "lane_a";

        Assert.Null(Assert.IsType<Arrival.Wait>(Navigator(document).Start()).GroupId);

        SampleWorkflow.Node(document, "task_1").Remove("laneId");
        Assert.Null(Assert.IsType<Arrival.Wait>(Navigator(document).Start()).GroupId);
    }

    [Fact]
    public void Loop_back_to_start_waits_at_start_for_the_requester_lane()
    {
        var document = SampleWorkflow.Create();
        SampleWorkflow.FlowById(document, "f_4")["target"] = "start_1";

        var wait = Assert.IsType<Arrival.Wait>(Navigator(document).After("gw_1", Branch.False));

        Assert.Equal("start_1", wait.Node.Id);
        Assert.Equal(TaskKindAtNode.Task, wait.Kind);
    }

    [Fact]
    public void Automation_step_is_dispatched_not_a_task()
    {
        var document = SampleWorkflow.Create();
        var task = SampleWorkflow.Node(document, "task_1");
        task.Remove("form");
        task["taskKind"] = "automation";
        task["automation"] = new JsonObject { ["automationId"] = "x" };

        Assert.Equal("task_1", Assert.IsType<Arrival.Automation>(Navigator(document).Start()).Node.Id);
    }

    [Fact]
    public void Subprocess_step_is_a_call()
    {
        var document = SampleWorkflow.Create();
        var task = SampleWorkflow.Node(document, "task_1");
        task.Remove("form");
        task["taskKind"] = "subprocess";
        task["workflow"] = new JsonObject { ["workflowId"] = "x" };
        var navigator = Navigator(document);

        Assert.Equal("task_1", Assert.IsType<Arrival.Subprocess>(navigator.Start()).Node.Id);
        Assert.Equal(["task_1"], navigator.Calls.Select(n => n.Id));
    }

    [Fact]
    public void Automatic_gateway_is_an_automatic_step()
    {
        var document = SampleWorkflow.Create();
        var gateway = SampleWorkflow.Node(document, "gw_1");
        gateway["decisionMode"] = "automatic";
        gateway.Remove("question");
        gateway["condition"] = new JsonObject { ["kind"] = "group", ["op"] = "and", ["items"] = new JsonArray() };

        Assert.Equal("gw_1", Assert.IsType<Arrival.Automatic>(Navigator(document).After("task_1")).Node.Id);
    }
}

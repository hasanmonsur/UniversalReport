using UniversalReport.AspNetCore;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddUniversalReport();

var app = builder.Build();
app.MapUniversalReportApi("/api/v1");
app.Run();
